# Changelog

All notable changes to Venom Board are listed here. The project follows [Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixes
- The Team panel keeps up live: projects your teammates make, rename or delete, invites being accepted, declined or withdrawn, and people joining, leaving or changing role show straight away, without restarting the app. Signed in, the app stays connected between projects for this, so notifications arrive straight away too
- An invite that arrives while you're working says so, even with the Team panel closed
- A view-only link or public roadmap made by another admin shows for everyone in the project at once, so nobody replaces a link without knowing it exists
- What you're typing in the Team panel or Settings stays put when it updates; a form that fails keeps what you typed so you can fix it
- Pressing Enter in the Discord webhook box saves it

## [1.3.0] - 2026-10-07

### Sharing
- **Public roadmaps**: publish a page players can follow from the Team panel: phases, what's planned, in progress and done, ideas if you want, and milestone dates with countdowns. Players vote for what they want most (the team sees the votes on the cards), follow it with RSS, and you can embed it on your own site. Pictures, comments, people and estimates are never shown; right-click a card to keep it off. Admins choose what shows and can take it down at any time
- **Link previews**: a view-only link or public roadmap posted on Discord, Reddit or X shows a picture of the board with its name. The picture updates as the board changes, or straight away from the Team panel
- The view-only page links back with "Make your own board · free"

### Planning
- **Game jam clock**: right-click the board → Game jam clock, or start from the 48-hour jam template. It counts down to the deadline (in the top bar too), shows the theme or when it's revealed, and checks the work left against the time you have. **Cut scope** marks the lowest-priority work Won't until it fits, never Must work. Reminders come at 24 hours, 6 hours, 1 hour and 15 minutes left
- Two new templates: **Game roadmap** (pre-production to launch with dated milestones) and **Art moodboard**
- Template links: venomboard.com/templates opens any template in the web app in one click

### References
- **Timelapse** (Boards menu): a video of the board coming together from its history, with a title, the time of each moment and a "Made with Venom Board" ending. Landscape, square or vertical; saved as MP4 where possible, otherwise WebM. Boards on this computer keep a snapshot every 20 minutes of work for it (the last 60)

### Fixes
- A narrow frame's progress moves inside its top corner instead of covering its title

## [1.2.0] - 2026-10-07

### Teams
- **Assign cards** to teammates: avatars on the card, an *Assign* button on the card toolbar and in the right-click menu, a *People* filter (with *Mine*) in the Planner, and assignees in Markdown and CSV exports
- **Comments and @mentions** on cards, in a panel that follows the selected card. Suggestions appear as you type `@`; only authors edit their comments, and authors or team admins delete them. Viewers can comment
- **Notifications**: a bell in the top bar for mentions and assignments; clicking one opens the project at the card. Mentions can also come by email, and a morning email lists your tasks due today or tomorrow, or late. Both can be turned off in the new **Settings → Notifications** page, or from a link in the email
- **Activity feed** in the Team panel: what changed, by whom, gathered into readable lines
- **Follow** a teammate's view by clicking their avatar; **Present to everyone** (editors and up) makes the whole project follow you. Step away from a presenter and they won't take your view again for ten minutes
- **Version history**: automatic versions before each burst of editing (hourly for two days, daily for a month) and named versions. Restore one for everyone (the board as it was is kept first) or open it as a separate copy
- **View-only links**: share a board with anyone, live and without an account. Watchers can't see who's there or change anything, and can report a board; admins can replace or turn off the link at any time
- **Discord**: a team admin can post finished tasks, reached milestones, comments, restores and new members to a channel
- **Two-step sign-in** with an authenticator app, with ten one-time recovery codes, in the app and on the website
- Comments and notifications show the writer's @username next to their name

### Planning
- **Timeline** (`Shift+G`): a schedule in working days from estimates and dependencies, the critical path, late due dates and finished work
- **Burndown chart** in the Planner, against a straight line to the next milestone
- **Import** from Trello, Jira or any CSV
- **Search everything** (`Ctrl+Shift+F`) across every board on this computer and every team project you're in

### References
- **Video**: drop or paste video files (they stay on this computer), or paste a YouTube or Vimeo link to pin a player that only loads when you double-click it
- GIFs animate on the board, as before

### Desktop
- **macOS** (Apple silicon and Intel) and **Linux** (AppImage) apps. Linux updates itself like Windows; macOS shows when a new version is out
- Each system only installs updates made for it: the signature check also confirms the file is a Windows installer or an AppImage

### Fair use
- Accounts, teams and shared projects have allowances, so nobody can fill the service or flood it with spam: how many teams you lead or are in, how many projects and people a team has, how big a shared board can grow, and how much storage (pictures, boards and their version history) a team and its leader use
- Until you confirm your email, your account can lead one team and make a few shared projects
- The Team panel shows how many of a team's projects and places are used and how much storage is used, and Settings shows your allowance
- A change that would push a shared board past its size limit is undone with a clear message

## [1.1.2] - 2026-10-07

### Settings
- A new **Settings** window: the gear button in the top bar, `Ctrl+,`, or **Settings** in the Window menu. Account, appearance, board, desktop window and about pages in one place
- **Account**: change your display name and the colour teammates see your cursor in, change your password, resend the confirmation email, see how many other devices you're signed in on and sign them all out, and delete your account
- The same sign-in and account options are on your account page at venomboard.com

### Fixes
- Changing a card's status from its toolbar or the right-click menu did nothing. In a team project it also made the app think its live connection had dropped, so your cursor froze for teammates and editing paused until a reload
- Your cursor stays live for teammates while it's over the card toolbar, the tools and the menus, and disappears when it leaves the window instead of freezing in place
- Middle-click panning in Linux browsers no longer drops the last selected text onto the board as a new card
- A teammate's new name or colour shows straight away in the avatars at the top

## [1.1.1] - 2026-10-06

### Fits any screen
- The top bar fits itself to the window: button labels drop first, then the least-used buttons fold into a new **⋯ More** menu, so nothing is cut off or hidden under the window buttons at low resolutions or high display scaling
- The tool spine shrinks on short screens instead of hiding tools off the bottom, and shows a scroll bar if a tiny window still can't fit them all
- The selection toolbar stays clear of the tool spine and the planner, and the coordinates readout no longer covers it on narrow windows
- **Interface size** (View menu, desktop app): 80% to 150%, to fit more on small screens or make everything bigger on large high-resolution ones
- The desktop window can't be made shorter than 400 px, so every tool always fits

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

[1.1.1]: https://github.com/1337VIPER/venom-board/releases/tag/v1.1.1
[1.1.0]: https://github.com/1337VIPER/venom-board/releases/tag/v1.1.0
[1.0.0]: https://github.com/1337VIPER/venom-board/releases/tag/v1.0.0
