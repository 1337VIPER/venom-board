# Changelog

All notable changes to Venom Board are listed here. The project follows [Semantic Versioning](https://semver.org).

## [1.1.0] - 2026-10-06

### Teams and live collaboration
- Free accounts at venomboard.com, usable from the website, the web app and the desktop app
- Teams with a leader, team admins, editors and viewers; invites by username or email that people accept or decline
- Shared projects: a project list for each team, and "Share this board" to turn any board into one
- Live editing: cards, connectors, frames, images, ink and text appear for everyone as they happen, including drags, resizes and typing in progress
- See who's here: avatars in the top bar, teammates' cursors and selections on the canvas, and "is typing…" labels
- Role changes, renames, removals and deletions take effect live
- Undo and redo only touch your own changes, and edits that hadn't reached the server when a connection dropped are sent again once it's back
- Email confirmation: invites sent to an email address only reach an account that has confirmed it
- Manage your account, teams, members and invites at venomboard.com

### Desktop app
- Windows installer: installs per user in seconds, no admin rights needed, with Start menu and desktop shortcuts
- Automatic updates: checks for new versions at start-up and every few hours, downloads them in the background and installs them on restart; *Restart to update* appears in the top bar, and **Check for updates** is in the Window menu
- Every update must carry Venom Board's update signature, made with a key that never leaves the developer's machine; downloads that don't match are thrown away, never installed
- Before restarting to update, the app saves your board and waits for live edits to reach your team

## [1.0.0] - 2026-10-06

The first public release.

### Reference board
- Infinite canvas with cursor-centred zoom, panning and a minimap
- Image paste, drag-and-drop from Explorer or a browser, flip, greyscale and original size
- Marker, highlighter and stroke eraser; ink rides along with the card or image it was drawn on
- Snap guides, align, distribute, grid packing, item lock and z-order
- PNG export of the whole board or the selection

### Planning
- Task, milestone, bug and idea cards with status, discipline, MoSCoW priority, estimates and due dates
- Checklists in card notes and clickable links
- Tendril connectors with curved, straight and elbow styles, arrowheads, dashes, labels and flow animation
- Place next: drag a connector into empty space to choose what comes next; `Tab` adds a connected task
- Dependency tracking with "waits on" counts, a Ready to start filter and dependency tracing
- Phase frames with progress and remaining-estimate headers
- Planner panel with progress stats, milestone countdowns, search and filters
- Ten game development templates
- Markdown and CSV export
- Board lock for view-only reviews

### Desktop app
- Pin on top, window opacity slider and window lock
- Click-through with a customisable global shortcut and a tray fallback
- Hide the top bar or the whole interface
- Right-click Window menu available anywhere
- Venom and Anti-Venom skins
- Native save and open dialogs; boards autosave locally

[1.1.0]: https://github.com/1337VIPER/venom-board/releases/tag/v1.1.0
[1.0.0]: https://github.com/1337VIPER/venom-board/releases/tag/v1.0.0
