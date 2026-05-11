from __future__ import annotations

import difflib
import html
import json
import re
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


PLUGIN_NAME = "Bang Marks Importer"

DUPLICATE_TOLERANCE_SECONDS = 0.25
LOW_CONFIDENCE_SCORE = 0.58

BANG_VIDEO_PAGE_PATH_RE = re.compile(
    r"^/video/(?!chapters/)(?P<public_id>[^/]+)(?:/.*)?/?$",
    flags=re.IGNORECASE,
)

CHAPTERS_PATH_RE = re.compile(
    r"^/video/chapters/(?P<video_id>[a-f0-9]{24})/?$",
    flags=re.IGNORECASE,
)

HTML_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

VTT_HEADERS = {
    "User-Agent": HTML_HEADERS["User-Agent"],
    "Accept": "text/vtt,*/*",
}


@dataclass(frozen=True)
class Cue:
    title: str
    start_seconds: float
    end_seconds: float | None


@dataclass(frozen=True)
class TagCandidate:
    tag: dict[str, Any]
    matched_value: str
    score: float
    reason: str


class PluginError(Exception):
    def __init__(self, status: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.details = details or {}


def log(message: str) -> None:
    print(f"[{PLUGIN_NAME}] {message}", file=sys.stderr, flush=True)


def read_plugin_input() -> dict[str, Any]:
    raw = sys.stdin.read()

    if not raw.strip():
        return {}

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PluginError("bad_input", f"Invalid plugin input JSON: {exc}") from exc


def plugin_output(payload: dict[str, Any], error: str | None = None) -> None:
    result: dict[str, Any] = {
        "output": payload,
    }

    if error:
        result["error"] = error

    print(json.dumps(result, ensure_ascii=False), flush=True)


def build_graphql_url(server_connection: dict[str, Any]) -> str:
    scheme = server_connection.get("Scheme") or server_connection.get("scheme") or "http"
    host = server_connection.get("Host") or server_connection.get("host") or "127.0.0.1"
    port = server_connection.get("Port") or server_connection.get("port") or 9999

    if host in ("0.0.0.0", "::", "[::]", ""):
        host = "127.0.0.1"

    return f"{scheme}://{host}:{port}/graphql"


def build_stash_headers(server_connection: dict[str, Any]) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    session_cookie = server_connection.get("SessionCookie") or server_connection.get("session_cookie") or {}
    cookie_name = session_cookie.get("Name") or session_cookie.get("name")
    cookie_value = session_cookie.get("Value") or session_cookie.get("value")

    if cookie_name and cookie_value:
        headers["Cookie"] = f"{cookie_name}={cookie_value}"

    return headers


def http_request(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str] | None = None,
    data: bytes | None = None,
    timeout: int = 30,
) -> tuple[int, str, dict[str, str]]:
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=headers or {},
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read().decode(charset, errors="replace")
            return response.status, body, dict(response.headers)
    except urllib.error.HTTPError as exc:
        charset = exc.headers.get_content_charset() or "utf-8"
        body = exc.read().decode(charset, errors="replace")
        return exc.code, body, dict(exc.headers)
    except urllib.error.URLError as exc:
        raise PluginError("network_error", f"Network error while fetching {url}: {exc}") from exc


def gql(
    graphql_url: str,
    stash_headers: dict[str, str],
    query: str,
    variables: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = json.dumps(
        {
            "query": query,
            "variables": variables or {},
        }
    ).encode("utf-8")

    status, body, _ = http_request(
        graphql_url,
        method="POST",
        headers=stash_headers,
        data=payload,
        timeout=30,
    )

    if status < 200 or status >= 300:
        raise PluginError(
            "stash_graphql_http_error",
            f"Stash GraphQL HTTP error {status}",
            {"body": body[:1200]},
        )

    try:
        decoded = json.loads(body)
    except json.JSONDecodeError as exc:
        raise PluginError(
            "stash_graphql_bad_json",
            "Stash GraphQL returned invalid JSON.",
            {"body": body[:1200]},
        ) from exc

    if decoded.get("errors"):
        raise PluginError(
            "stash_graphql_error",
            "Stash GraphQL returned errors.",
            {"errors": decoded["errors"]},
        )

    return decoded.get("data") or {}


def find_scene(graphql_url: str, stash_headers: dict[str, str], scene_id: str) -> dict[str, Any]:
    query = """
      query FindSceneForBangChapters($id: ID!) {
        findScene(id: $id) {
          id
          title
          url
          urls
          tags {
            id
            name
            aliases
          }
          scene_markers {
            id
            title
            seconds
            end_seconds
            primary_tag {
              id
              name
              aliases
            }
            tags {
              id
              name
              aliases
            }
          }
        }
      }
    """

    data = gql(graphql_url, stash_headers, query, {"id": scene_id})
    scene = data.get("findScene")

    if not scene:
        raise PluginError("scene_not_found", f"Scene not found: {scene_id}")

    return scene


def get_all_tags(graphql_url: str, stash_headers: dict[str, str]) -> list[dict[str, Any]]:
    query = """
      query AllTagsForBangChapters {
        allTags {
          id
          name
          aliases
        }
      }
    """

    data = gql(graphql_url, stash_headers, query)
    tags = data.get("allTags") or []
    return [tag for tag in tags if tag.get("id") and tag.get("name")]


def normalize_text(value: str) -> str:
    value = html.unescape(value or "")
    value = value.casefold()
    value = value.replace("&", " and ")
    value = re.sub(r"[-_/\\]+", " ", value)
    value = re.sub(r"[^a-z0-9\s]+", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def token_set(value: str) -> set[str]:
    ignored = {
        "a",
        "an",
        "and",
        "the",
        "to",
        "of",
        "with",
        "in",
        "on",
        "at",
        "for",
        "is",
        "her",
        "his",
        "she",
        "he",
        "scene",
        "chapter",
    }

    return {part for part in normalize_text(value).split() if part and part not in ignored}


def tag_values(tag: dict[str, Any]) -> list[str]:
    values = [str(tag.get("name") or "")]

    aliases = tag.get("aliases") or []
    if isinstance(aliases, list):
        values.extend(str(alias or "") for alias in aliases)

    clean_values = []
    seen = set()

    for value in values:
        normalized = normalize_text(value)
        if normalized and normalized not in seen:
            clean_values.append(value)
            seen.add(normalized)

    return clean_values


def score_tag_value(cue_title: str, tag_value: str) -> tuple[float, str]:
    cue_norm = normalize_text(cue_title)
    tag_norm = normalize_text(tag_value)

    if not cue_norm or not tag_norm:
        return 0.0, "empty"

    if cue_norm == tag_norm:
        return 1.0, "exact"

    cue_tokens = token_set(cue_title)
    tag_tokens = token_set(tag_value)

    if cue_tokens and tag_tokens:
        if tag_tokens.issubset(cue_tokens):
            return 0.92 if len(tag_tokens) >= 2 else 0.86, "tag_tokens_in_title"

        if cue_tokens.issubset(tag_tokens):
            return 0.82, "title_tokens_in_tag"

        overlap = len(cue_tokens & tag_tokens)
        union = len(cue_tokens | tag_tokens)

        if union:
            jaccard = overlap / union
            if jaccard >= 0.5:
                return min(0.78 + jaccard * 0.12, 0.9), "token_overlap"

    if f" {tag_norm} " in f" {cue_norm} ":
        return 0.84, "substring"

    if f" {cue_norm} " in f" {tag_norm} ":
        return 0.72, "reverse_substring"

    ratio = difflib.SequenceMatcher(None, cue_norm, tag_norm).ratio()

    return ratio * 0.70, "fuzzy"


def find_nearest_tag(cue_title: str, all_tags: list[dict[str, Any]], scene_tags: list[dict[str, Any]]) -> TagCandidate:
    scene_tag_ids = {str(tag.get("id")) for tag in scene_tags if tag.get("id")}

    best: TagCandidate | None = None

    for tag in all_tags:
        for value in tag_values(tag):
            score, reason = score_tag_value(cue_title, value)

            if str(tag.get("id")) in scene_tag_ids:
                score = min(1.0, score + 0.04)

            candidate = TagCandidate(
                tag=tag,
                matched_value=value,
                score=score,
                reason=reason,
            )

            if best is None or candidate.score > best.score:
                best = candidate

    if best is None:
        raise PluginError("no_tags", "No existing Stash tags found. Cannot create markers without primary_tag_id.")

    return best


def extract_all_urls(scene: dict[str, Any]) -> list[str]:
    candidates: list[str] = []

    deprecated_url = scene.get("url")
    if isinstance(deprecated_url, str) and deprecated_url.strip():
        candidates.append(deprecated_url.strip())

    urls = scene.get("urls") or []
    if isinstance(urls, list):
        for url in urls:
            if isinstance(url, str) and url.strip():
                candidates.append(url.strip())

    unique: list[str] = []
    seen = set()

    for url in candidates:
        if url not in seen:
            unique.append(url)
            seen.add(url)

    return unique


def is_bang_url(url: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return False

    host = (parsed.hostname or "").casefold()
    return host == "bang.com" or host.endswith(".bang.com")


def is_bang_video_page_url(url: str) -> bool:
    if not is_bang_url(url):
        return False

    parsed = urllib.parse.urlparse(url)
    return bool(BANG_VIDEO_PAGE_PATH_RE.match(parsed.path))


def parse_direct_chapters_url(url: str) -> tuple[str, str] | None:
    if not is_bang_url(url):
        return None

    parsed = urllib.parse.urlparse(url)
    match = CHAPTERS_PATH_RE.match(parsed.path)

    if not match:
        return None

    video_id = match.group("video_id").lower()
    clean_url = f"https://www.bang.com/video/chapters/{video_id}"

    return clean_url, video_id


def select_bang_video_page_url(scene: dict[str, Any]) -> dict[str, Any]:
    urls = extract_all_urls(scene)

    bang_urls = [url for url in urls if is_bang_url(url)]
    if not bang_urls:
        return {
            "status": "no_bang_url",
            "message": "No Bang.com URL found on this scene.",
            "urls": urls,
        }

    video_page_urls = [url for url in bang_urls if is_bang_video_page_url(url)]
    if video_page_urls:
        return {
            "mode": "video_page",
            "page_url": video_page_urls[0],
            "source_url": video_page_urls[0],
        }

    # Optional support if a direct chapters endpoint is stored manually.
    for url in bang_urls:
        parsed_chapters = parse_direct_chapters_url(url)
        if parsed_chapters:
            chapters_url, video_id = parsed_chapters
            return {
                "mode": "direct_chapters",
                "page_url": None,
                "chapters_url": chapters_url,
                "video_id": video_id,
                "source_url": url,
            }

    if True:
        return {
            "status": "no_bang_video_page_url",
            "message": "Bang.com URL found, but no /video/<id>/<slug> page URL found.",
            "bang_urls": bang_urls,
        }

    return {
        "mode": "video_page",
        "page_url": video_page_urls[0],
        "source_url": video_page_urls[0],
    }


def fetch_html(url: str) -> str:
    status, body, _ = http_request(url, headers=HTML_HEADERS, timeout=30)

    if status < 200 or status >= 300:
        raise PluginError(
            "bang_page_fetch_failed",
            f"Bang page fetch failed with HTTP {status}.",
            {
                "page_url": url,
                "http_status": status,
                "body_preview": body[:500],
            },
        )

    return body


def extract_video_id_from_player_json(page_html: str) -> str | None:
    patterns = [
        r'data-videoplayer-video-value="([^"]+)"',
        r"data-videoplayer-video-value='([^']+)'",
    ]

    for pattern in patterns:
        match = re.search(pattern, page_html)
        if not match:
            continue

        raw_value = html.unescape(match.group(1))

        try:
            video_data = json.loads(raw_value)
        except json.JSONDecodeError:
            continue

        video_id = video_data.get("id")

        if isinstance(video_id, str) and re.fullmatch(r"[a-f0-9]{24}", video_id):
            return video_id

    return None


def extract_video_id_from_preview_tag(page_html: str) -> str | None:
    match = re.search(r'id=["\']vpagepreview-([a-f0-9]{24})["\']', page_html)
    if match:
        return match.group(1).lower()

    return None


def extract_video_id_from_any_usable_hint(page_html: str) -> str | None:
    # Nejdřív přesně cílené metody, potom konzervativní fallback.
    video_id = extract_video_id_from_player_json(page_html) or extract_video_id_from_preview_tag(page_html)

    if video_id:
        return video_id

    # Fallback pro případ, že Bang změní atribut, ale v HTML zůstane chapters URL.
    match = re.search(r"/video/chapters/([a-f0-9]{24})", page_html, flags=re.IGNORECASE)
    if match:
        return match.group(1).lower()

    return None


def build_chapters_url(video_id: str) -> str:
    return f"https://www.bang.com/video/chapters/{video_id}"


def resolve_chapters_source(scene: dict[str, Any]) -> dict[str, Any]:
    selected = select_bang_video_page_url(scene)

    if selected.get("status"):
        return selected

    if selected["mode"] == "direct_chapters":
        return selected

    page_url = selected["page_url"]

    # HTML se drží jen v paměti procesu, nikam se neukládá.
    page_html = fetch_html(page_url)
    video_id = extract_video_id_from_any_usable_hint(page_html)

    if not video_id:
        return {
            "status": "no_internal_video_id",
            "message": "Could not find Bang internal 24 hex video ID in the video page HTML.",
            "page_url": page_url,
        }

    return {
        "mode": "video_page",
        "page_url": page_url,
        "source_url": page_url,
        "video_id": video_id,
        "chapters_url": build_chapters_url(video_id),
    }


def fetch_chapters_vtt(chapters_url: str, referer: str | None) -> str:
    headers = dict(VTT_HEADERS)
    if referer:
        headers["Referer"] = referer

    status, body, _ = http_request(chapters_url, headers=headers, timeout=30)

    if status == 404:
        raise PluginError(
            "no_chapters",
            "Bang marks endpoint returned HTTP 404.",
            {
                "chapters_url": chapters_url,
                "http_status": status,
            },
        )

    if status < 200 or status >= 300:
        raise PluginError(
            "chapters_fetch_failed",
            f"Bang marks fetch failed with HTTP {status}.",
            {
                "chapters_url": chapters_url,
                "http_status": status,
                "body_preview": body[:500],
            },
        )

    return body


def strip_webvtt_tags(value: str) -> str:
    value = re.sub(r"<[^>]+>", "", value)
    value = html.unescape(value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def parse_timestamp_to_seconds(value: str) -> float:
    value = value.strip().replace(",", ".")
    parts = value.split(":")

    if len(parts) == 3:
        hours = int(parts[0])
        minutes = int(parts[1])
        seconds = float(parts[2])
        return hours * 3600 + minutes * 60 + seconds

    if len(parts) == 2:
        minutes = int(parts[0])
        seconds = float(parts[1])
        return minutes * 60 + seconds

    raise ValueError(f"Invalid WEBVTT timestamp: {value}")


def parse_webvtt(vtt: str) -> list[Cue]:
    text = vtt.replace("\r\n", "\n").replace("\r", "\n").strip("\ufeff")

    if not text.strip():
        return []

    if not text.lstrip().startswith("WEBVTT"):
        raise PluginError(
            "invalid_vtt",
            "Response does not start with WEBVTT.",
            {"body_preview": text[:500]},
        )

    blocks = re.split(r"\n\s*\n", text)
    cues: list[Cue] = []

    for block in blocks:
        lines = [line.strip() for line in block.split("\n") if line.strip()]

        if not lines:
            continue

        first = lines[0].upper()
        if first.startswith("WEBVTT") or first.startswith("NOTE") or first.startswith("STYLE") or first.startswith("REGION"):
            continue

        timing_line_index = None
        for index, line in enumerate(lines):
            if "-->" in line:
                timing_line_index = index
                break

        if timing_line_index is None:
            continue

        timing_line = lines[timing_line_index]
        timing_match = re.match(r"^(.+?)\s+-->\s+([^\s]+)(?:\s+.*)?$", timing_line)

        if not timing_match:
            continue

        start_seconds = parse_timestamp_to_seconds(timing_match.group(1))
        end_seconds = parse_timestamp_to_seconds(timing_match.group(2))

        payload_lines = lines[timing_line_index + 1 :]
        title = strip_webvtt_tags(" ".join(payload_lines))

        if not title:
            title = f"Chapter {len(cues) + 1}"

        if end_seconds <= start_seconds:
            end_value: float | None = None
        else:
            end_value = end_seconds

        cues.append(
            Cue(
                title=title,
                start_seconds=round(start_seconds, 3),
                end_seconds=round(end_value, 3) if end_value is not None else None,
            )
        )

    return cues


def normalize_marker_title(value: str) -> str:
    value = strip_webvtt_tags(value)
    value = re.sub(r"\s+", " ", value)
    return value.casefold().strip()


def marker_is_duplicate(existing_marker: dict[str, Any], cue: Cue) -> bool:
    existing_seconds = existing_marker.get("seconds")

    if not isinstance(existing_seconds, (int, float)):
        return False

    if abs(float(existing_seconds) - cue.start_seconds) > DUPLICATE_TOLERANCE_SECONDS:
        return False

    existing_title = normalize_marker_title(str(existing_marker.get("title") or ""))
    cue_title = normalize_marker_title(cue.title)

    return existing_title == cue_title


def create_scene_marker(
    graphql_url: str,
    stash_headers: dict[str, str],
    *,
    scene_id: str,
    cue: Cue,
    primary_tag_id: str,
) -> dict[str, Any]:
    mutation = """
      mutation CreateBangChapterMarker($input: SceneMarkerCreateInput!) {
        sceneMarkerCreate(input: $input) {
          id
          title
          seconds
          end_seconds
          primary_tag {
            id
            name
          }
          tags {
            id
            name
          }
        }
      }
    """

    marker_input: dict[str, Any] = {
        "scene_id": scene_id,
        "title": cue.title,
        "seconds": cue.start_seconds,
        "primary_tag_id": primary_tag_id,
    }

    if cue.end_seconds is not None:
        marker_input["end_seconds"] = cue.end_seconds

    data = gql(
        graphql_url,
        stash_headers,
        mutation,
        {
            "input": marker_input,
        },
    )

    marker = data.get("sceneMarkerCreate")

    if not marker:
        raise PluginError("marker_create_failed", f"Failed to create marker: {cue.title}")

    return marker



def import_single_scene(
    graphql_url: str,
    stash_headers: dict[str, str],
    *,
    scene_id: str,
    all_tags: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    log(f"Starting import for scene_id={scene_id}")

    scene = find_scene(graphql_url, stash_headers, scene_id)
    source = resolve_chapters_source(scene)

    if source.get("status"):
        return {
            "status": source["status"],
            "scene_id": scene_id,
            "scene_title": scene.get("title"),
            "message": source.get("message"),
            "bang_urls": source.get("bang_urls"),
            "urls": source.get("urls"),
            "page_url": source.get("page_url"),
        }

    chapters_url = source["chapters_url"]
    video_id = source["video_id"]
    page_url = source.get("page_url")

    log(f"Source URL: {source.get('source_url')} | chapters URL: {chapters_url}")

    vtt = fetch_chapters_vtt(chapters_url, referer=page_url or source.get("source_url"))

    if not vtt.strip():
        return {
            "status": "no_chapters",
            "scene_id": scene_id,
            "scene_title": scene.get("title"),
            "video_id": video_id,
            "page_url": page_url,
            "chapters_url": chapters_url,
            "message": "Bang marks response is empty.",
        }

    cues = parse_webvtt(vtt)

    if not cues:
        return {
            "status": "no_chapters",
            "scene_id": scene_id,
            "scene_title": scene.get("title"),
            "video_id": video_id,
            "page_url": page_url,
            "chapters_url": chapters_url,
            "message": "WEBVTT contains no cues.",
        }

    tags = all_tags if all_tags is not None else get_all_tags(graphql_url, stash_headers)

    if not tags:
        return {
            "status": "no_tags",
            "scene_id": scene_id,
            "scene_title": scene.get("title"),
            "video_id": video_id,
            "page_url": page_url,
            "chapters_url": chapters_url,
            "message": "No tags exist in Stash. Cannot create scene markers without primary_tag_id.",
        }

    scene_tags = scene.get("tags") or []
    existing_markers = scene.get("scene_markers") or []

    created: list[dict[str, Any]] = []
    skipped_duplicates = 0
    errors: list[dict[str, str]] = []
    tag_matches: list[dict[str, Any]] = []
    skipped_low_confidence: list[dict[str, Any]] = []

    for cue in cues:
        if any(marker_is_duplicate(existing_marker, cue) for existing_marker in existing_markers):
            skipped_duplicates += 1
            continue

        try:
            candidate = find_nearest_tag(cue.title, tags, scene_tags)
            tag = candidate.tag

            if candidate.score < LOW_CONFIDENCE_SCORE:
                skipped_low_confidence.append(
                    {
                        "title": cue.title,
                        "seconds": cue.start_seconds,
                        "tag_id": tag.get("id"),
                        "tag_name": tag.get("name"),
                        "matched_value": candidate.matched_value,
                        "score": round(candidate.score, 4),
                        "reason": candidate.reason,
                        "threshold": LOW_CONFIDENCE_SCORE,
                    }
                )
                log(
                    f"Skipped marker {cue.title!r} at {cue.start_seconds}: "
                    f"best tag {tag.get('name')!r} scored {candidate.score:.4f}, "
                    f"threshold is {LOW_CONFIDENCE_SCORE:.2f}"
                )
                continue

            marker = create_scene_marker(
                graphql_url,
                stash_headers,
                scene_id=scene_id,
                cue=cue,
                primary_tag_id=str(tag["id"]),
            )

            created.append(marker)

            tag_matches.append(
                {
                    "marker_id": marker.get("id"),
                    "title": cue.title,
                    "seconds": cue.start_seconds,
                    "tag_id": tag.get("id"),
                    "tag_name": tag.get("name"),
                    "matched_value": candidate.matched_value,
                    "score": round(candidate.score, 4),
                    "reason": candidate.reason,
                    "low_confidence": False,
                }
            )

            existing_markers.append(
                {
                    "id": marker.get("id"),
                    "title": marker.get("title"),
                    "seconds": marker.get("seconds"),
                    "end_seconds": marker.get("end_seconds"),
                    "primary_tag": {
                        "id": tag.get("id"),
                        "name": tag.get("name"),
                    },
                    "tags": [],
                }
            )
        except Exception as exc:
            errors.append(
                {
                    "title": cue.title,
                    "seconds": str(cue.start_seconds),
                    "error": str(exc),
                }
            )
            log(f"Failed to create marker {cue.title!r} at {cue.start_seconds}: {exc}")

    skipped_low_confidence_count = len(skipped_low_confidence)

    if created and (errors or skipped_low_confidence):
        status = "partial_success"
    elif created:
        status = "success"
    elif skipped_duplicates and not skipped_low_confidence:
        status = "all_duplicates"
    elif skipped_low_confidence:
        status = "no_safe_tag_match"
    else:
        status = "no_chapters"

    return {
        "status": status,
        "scene_id": scene_id,
        "scene_title": scene.get("title"),
        "video_id": video_id,
        "page_url": page_url,
        "chapters_url": chapters_url,
        "source_url": source.get("source_url"),
        "source_mode": source.get("mode"),
        "cue_count": len(cues),
        "created_count": len(created),
        "created_markers": created,
        "skipped_duplicates": skipped_duplicates,
        "error_count": len(errors),
        "errors": errors,
        "tag_match_count": len(tag_matches),
        "low_confidence_count": 0,
        "skipped_low_confidence_count": skipped_low_confidence_count,
        "skipped_low_confidence": skipped_low_confidence,
        "tag_match_threshold": LOW_CONFIDENCE_SCORE,
        "tag_matches": tag_matches,
    }


def normalize_scene_ids(value: Any) -> list[str]:
    if value is None:
        return []

    raw_values = value if isinstance(value, list) else [value]
    ids: list[str] = []
    seen = set()

    for raw in raw_values:
        scene_id = str(raw or "").strip()

        if not scene_id or not scene_id.isdigit() or scene_id in seen:
            continue

        ids.append(scene_id)
        seen.add(scene_id)

    return ids


def is_success_like(status: str) -> bool:
    return status in {"success", "partial_success", "all_duplicates"}


def is_failure_like(status: str) -> bool:
    return status in {
        "error",
        "network_error",
        "stash_graphql_error",
        "stash_graphql_http_error",
        "scene_not_found",
        "bang_page_fetch_failed",
        "chapters_fetch_failed",
        "invalid_vtt",
    }


def import_bulk_scenes(
    graphql_url: str,
    stash_headers: dict[str, str],
    *,
    scene_ids: list[str],
) -> dict[str, Any]:
    if not scene_ids:
        return {
            "status": "bulk_empty",
            "total": 0,
            "message": "No scene IDs were provided.",
        }

    all_tags = get_all_tags(graphql_url, stash_headers)
    results: list[dict[str, Any]] = []

    for index, scene_id in enumerate(scene_ids, start=1):
        log(f"Bulk import {index}/{len(scene_ids)} scene_id={scene_id}")

        try:
            result = import_single_scene(
                graphql_url,
                stash_headers,
                scene_id=scene_id,
                all_tags=all_tags,
            )
        except PluginError as exc:
            result = {
                "status": exc.status,
                "scene_id": scene_id,
                "message": exc.message,
                **exc.details,
            }
        except Exception as exc:
            result = {
                "status": "error",
                "scene_id": scene_id,
                "message": str(exc),
            }

        results.append(result)

    success_count = sum(1 for item in results if is_success_like(str(item.get("status") or "")))
    failed_count = sum(1 for item in results if is_failure_like(str(item.get("status") or "")))
    skipped_count = len(results) - success_count - failed_count

    return {
        "status": "bulk_completed",
        "total": len(results),
        "success_count": success_count,
        "skipped_count": skipped_count,
        "failed_count": failed_count,
        "created_total": sum(int(item.get("created_count") or 0) for item in results),
        "duplicate_total": sum(int(item.get("skipped_duplicates") or 0) for item in results),
        "low_confidence_total": 0,
        "low_confidence_skipped_total": sum(int(item.get("skipped_low_confidence_count") or 0) for item in results),
        "results": results,
    }


def import_bang_chapters(plugin_input: dict[str, Any]) -> dict[str, Any]:
    args = plugin_input.get("args") or {}

    server_connection = plugin_input.get("server_connection") or {}
    graphql_url = build_graphql_url(server_connection)
    stash_headers = build_stash_headers(server_connection)

    scene_ids = normalize_scene_ids(args.get("scene_ids"))

    if scene_ids:
        return import_bulk_scenes(
            graphql_url,
            stash_headers,
            scene_ids=scene_ids,
        )

    scene_id = str(args.get("scene_id") or "").strip()

    if not scene_id:
        raise PluginError("missing_scene_id", "Missing required args.scene_id or args.scene_ids.")

    return import_single_scene(
        graphql_url,
        stash_headers,
        scene_id=scene_id,
    )

def main() -> None:
    try:
        plugin_input = read_plugin_input()
        result = import_bang_chapters(plugin_input)
        plugin_output(result)
    except PluginError as exc:
        payload = {
            "status": exc.status,
            "message": exc.message,
            **exc.details,
        }

        log(f"{exc.status}: {exc.message}")
        plugin_output(payload, error=exc.message)
    except Exception as exc:
        log("Unhandled error:")
        traceback.print_exc(file=sys.stderr)

        plugin_output(
            {
                "status": "error",
                "message": str(exc),
            },
            error=str(exc),
        )


if __name__ == "__main__":
    main()
