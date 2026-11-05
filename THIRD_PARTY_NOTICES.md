# Third-party components

`src/vendor/remotebrowser/cdp.ts` and `types.ts` were copied from
[yvonuk/remotebrowser](https://github.com/yvonuk/remotebrowser), commit
`bcab9f59bfad1cffa0618ccced05cc17b6fd8810` (MIT, copyright 2026 Yu Wang).
The original license is retained at `src/vendor/remotebrowser/LICENSE`.

RelayHub modifies keyboard dispatch to use a single CDP path with explicit key
down/up events, Enter character dispatch, and explicit Chromium select-all commands
for Ctrl+A / Command+A across host operating systems. The original silent Playwright-to-CDP fallback is removed.
Browser-context ownership, persistence, authentication, permission assignment,
page capture, and the management interface are RelayHub integration code.

Runtime dependencies: Playwright (Apache-2.0), Hono and @hono/node-server (MIT),
ws (MIT), Zod (MIT), proxy-chain (Apache-2.0), ipaddr.js (MIT).
Exact installed versions are recorded in package-lock.json.

Design references supplied in the project brief:

- https://github.com/xieguu/gpt-set — persistent session / multiple windows.
- https://github.com/amsasw/url-set — navigation and popup association.
- https://github.com/Rextrad/chatgpt-web-share — portal-level user management.

No source files from these three reference repositories were copied.
