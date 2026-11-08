# Nav Hub

Nav Hub groups supported Stash plugin buttons into a single **Plugins** menu. It opens as a bottom sheet below 1200 px and as a dropdown on wider screens. It runs in the browser with no build step, external requests, or backend dependencies.

I built Nav Hub to give plugins a dedicated place in Stash's default navigation. As I added more plugins, their buttons crowded the top bar until I could no longer see the button that opens Stash's main menu on mobile.

## Install

1. Copy the `NavHub` folder containing `navhub.yml` and `ui/` into your Stash `plugins` directory.
2. In Stash, go to **Settings → Plugins** and click **Reload Plugins**, then refresh the browser.
3. Open **Plugins** in the top navigation. Use the gear button to open settings.

If you use a Stash plugin source that lists Nav Hub, you can also install it under **Settings → Plugins → Available Plugins**. To uninstall a manual copy, remove the folder, reload plugins, and refresh the page to restore the original buttons.

## Use the menu

- In settings, use the arrow buttons to reorder entries. Turn off **Manage** to restore a plugin's original button.
- Use **Pin** to add a desktop shortcut. Pinned actions are available inside the menu on smaller screens.
- Preferences are saved in local storage for this browser and Stash address. If storage is unavailable, settings last until you refresh.
- Press Escape, use the close button, or click outside the panel to close it. Tab stays within the open panel.
- On smaller screens, duplicate Stash utility buttons such as Stats are hidden when Nav Hub finds a matching entry in the collapsed main navigation.

## Built-in integrations

| Plugin | Button selector |
| --- | --- |
| PMV Generator | `.pmvg-nav-btn` |
| RedTok | `.redtok-nav-btn` |
| SFW | `#plugin_sfw` |
| Media Storm | `.ms-nav-btn` |
| Downloader | `#stash-downloader-nav-button` |
| O Stickers | `.ostickers-toggle-button` |

Only detected buttons appear. Nav Hub hides each original button in place and invokes its click handler through `.click()`. It copies the SVG icon when available, tracks disabled and pressed states, and detects buttons added or replaced after page load.

These integrations depend on Stash's navigation markup and each plugin's selectors and click behavior. If an action requires a trusted click, another event type, or a gesture such as a middle-click, use **Manage** to restore the original button. The included browser test uses simulated navigation. Compatibility with specific Stash and plugin versions still needs verification on a live installation.

## Integration API

`window.NavHub.register(definition)` adds or replaces an entry and returns a function that unregisters it. Use the existing ID to replace a built-in integration.

```js
function registerWithNavHub() {
  window.NavHub.register({
    id: 'my-tool',
    label: 'My Tool',
    icon: '↓', // Plain text or emoji
    onClick: () => openMyTool(),
  });

  document.querySelector('#my-tool-button')?.remove();
}

if (window.NavHub) {
  registerWithNavHub();
} else {
  window.addEventListener('navhub:ready', registerWithNavHub, { once: true });
}
```

In this example, `openMyTool` is your plugin's existing action and `#my-tool-button` is its own fallback button. You can also register an existing button directly.

```js
const unregister = window.NavHub.register({
  id: 'my-tool',
  label: 'My Tool',
  selector: '#my-tool-button',
});
```

Selectors are matched inside `nav.top-nav`. If you supply both a selector and an `onClick` handler, the matched button takes precedence and the handler acts as a fallback. Entries without an original button cannot be switched off with **Manage**.

Optional fields include `disabled` and `pressed` booleans. Register an entry again to update it. Use `NavHub.refresh()` to schedule a scan, or `NavHub.open()` and `NavHub.close()` to control the panel. The API is available before the navigation is mounted, and `window` receives `navhub:ready` after initialization.

## Test

Open `tests/integration.html` in a browser using a separate local origin. The test resets the `stash.navhub.v1` preferences key on that origin. It covers click forwarding, navigation replacement, disabled and pressed states, API registration, settings, pinning, reordering, keyboard focus, and panel sizing. Add `?preview` to leave the panel open for inspection.

## License

[AGPL-3.0](LICENSE).
