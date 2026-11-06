---
version: 1
slug: 'packages-ui-src-chat-css'
primary_target: 'packages/ui/src/chat.css'
related_targets: ['packages/ui/src/access.css']
---

Scope: every Huddle screen (chat shell, Home, Members, dialogs, settings, setup, join). Mode: Operate.
Audience and job: a host and their friends chatting in a self-hosted, text-only server, mostly in the desktop app.
Constraints: keeps the Huddle name and logo. No Discord logo, illustrations, or proprietary font. No controls for features that are not built. Voice channels list and open to a not-available notice, with no call controls.
Theme: the scheme follows the system until someone chooses otherwise in Settings. The default theme is Huddle, whose values take T3 Code's as their reference in both schemes. In Settings' Appearance tab, a person can pick the other built-in themes (Indigo, Moss, Harbor, Clay, Plum) or create or import their own, on their own device.

## Direction contract

THESIS: A Discord user should know where everything is at first sight. The user pinned this direction; the roll did not run. It refuses Huddle's previous quiet SaaS arrangement of breadcrumbs, bubbles, and a centered column.

OWN-WORLD: In the default Huddle theme, a neutral shell (#f4f4f5 light, #000000 dark) around a slightly lifted chat ground (#fcfcfc, #0a0a0a), one blue accent (#1b4ed8, #346bf1), rounded-square rail tiles, flat full-width messages, a floating account panel. Huddle's logo marks the rail.

STORY: The visitor picks a room on the rail, reads the current channel, scans the room's channels at left and members at right, and types in the composer. Home holds the visitor's direct messages, and room activity shows on the rail as unread pills and mention counts.

FIRST VIEWPORT: 32px title bar on every platform. In the desktop app it is a merged window bar over every screen. 72px rail of rooms. 248px channel sidebar. Flexible chat. 240px member list. Composer at the bottom. Account panel floats across rail and sidebar.

FORM: Discord's desktop shell, pinned by the user, played straight. seed: none (user-pinned, roll not run)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
