# Changelog

All notable changes to Venom Board are listed here. The project follows [Semantic Versioning](https://semver.org).

## [1.5.1] - 2026-10-08

### Teams
- **One session per account on a board**: a team board can be open in one session of an account at a time, so one account signed in on two computers (or shared) can't work on the same board from both. Opening it somewhere else says where it's open and offers *Use it here*, which moves the board to this window and sends the other one back to its own boards. Tabs of one signed-in browser count as one session, and other teammates are never affected

### Security
- On venomboard.com the web app signs in with the website's secure cookie, and copies of the app on other sites keep your sign-in only while they're open
- A strict content security policy for the app, and the desktop app refuses permissions it never uses (camera, microphone, location and the rest)
- Pasted pictures only come from web or data addresses
- CSV export marks cells that start with `=`, `+`, `-` or `@` so spreadsheets don't read them as formulas
- Making new recovery codes for two-step sign-in asks for a current code from your authenticator app

### Fixed
- The toolbar under a selected card fits on one row on laptop-sized windows

## [1.5.0] - 2026-10-08

### Planning
- **Kanban view** (`Shift+K`): the same cards in To do, In progress, Blocked and Done columns, with filters for type, phase, discipline and people (including *Mine*). Drag a card to another column to change its status; click one to jump to it on the board
- **Calendar view** (`Shift+C`): due dates and milestones on a month grid, overdue work in red. Drag a card to another day to change its due date, or from the *No due date* list to give it one
- **Timeline you can drag**: drag the end of a task's bar to change its estimate, or a milestone to move its date, and watch the schedule and critical path update as you go
- **Time tracking**: *Start timer* on a card, and a chip in the top bar counts until you stop it. Cards show tracked time against the estimate (amber when over), and the Planner adds it all up. The running timer stays on your computer; only the total is shared
- **Sprints**: right-click a phase → *Make this a sprint…* with dates and capacity per teammate. The phase shows the days left, and the Planner shows progress, capacity against what's assigned to each person, and your velocity over past sprints
- **Tags and saved filters**: up to 8 tags per card, shown on the card and filterable in the Planner (click a tag to filter by it). Save a set of filters under a name and pick it again later
- **Spread wires**: connectors that leave the same side of a card fan out, wires sharing a corridor get their own lanes, and straight wires between the same two cards sit side by side, so nothing hides behind anything else
- **Collapse a phase**: fold a phase down to its title bar with a summary like "5 cards · 2 done". What's inside is hidden, wires attach to the bar, and moving it carries everything
- **Tidy layout**: lay cards out left to right by what they wait on, with fewer crossings and even spacing: for the selection, one phase or the whole board, in one undo step
- **Card pins**: drag the dot on a card's right edge to connect what comes next, or the one on its left to connect what it waits on, Blueprint-style

### Reference board
- **Crop and rotate pictures**: *Crop* shows the whole picture with a frame to drag (Enter applies, Esc cancels, *Reset crop* undoes it), and *Rotate left/right* turns it in quarter turns. Nothing is re-encoded, and exports, timelapses, *Original size* and *Replace* all follow along
- **Colour picker** (`K`): click any pixel of any picture to copy its colour and use it for ink, text and cards
- **Extract palette**: the main colours of a picture as a swatch strip with hex codes, placed right under it
- **Export to PureRef**: *Export → PureRef board (.pur)* saves pictures (with their crops, turns and flips) and text for PureRef. PureRef imports now keep crops and quarter turns as they are, and notes land where PureRef draws them

### Teams
- **Comment threads**: reply to a comment (the thread's author is notified), react with 👍 ❤️ 🎉 😂 👀 ✅ (your own reactions only, and they never notify anyone), and resolve a thread when it's handled; resolved threads fold away. The thread's author or a team admin can resolve or reopen it
- **Feedback pins on pictures**: drop a numbered pin on a spot of a picture to start a thread there. Pins follow the picture as it moves, resizes, flips, crops or turns, and fade once resolved
- **GitHub and GitLab**: every card has a reference like `VB-7K2QX9MD` (right-click → *Copy reference*). Connect a repository from the Team panel, and commits, pull requests and merge requests that mention a card comment on it with a link; "fixes VB-…" on the default branch, or a merged request, finishes the card. Cards can list linked pull requests and issues too
- **Slack**: post finished tasks, reached milestones, comments and more to a Slack channel, the same way as Discord
- **Roles in one project**: team admins can make someone view-only in one project, or let a viewer edit one, from that project's *People* control. It takes effect straight away
- **Playtest feedback form**: a public link for a project where playtesters send bugs and ideas, with a screenshot if they like. Each one lands on the board as a card in a *Playtest inbox* phase, live. Admins can pause it, change the link or turn it off
- **In-game bug reporter**: a report key per project lets your game send bug reports straight to the board, with severity, version, platform, the end of the log and a screenshot. A repeat of the same bug adds a comment instead of a new card. Ready-made code for Godot, Unity, Unreal and curl is in [`integrations/bug-reporter`](integrations/bug-reporter)
- **Calendar feed**: a private address for Google Calendar, Outlook or Apple Calendar with your assigned cards' due dates and your projects' milestones. Turn it on at venomboard.com/account (Settings → Account links there); changing your password or signing out everywhere turns it off

### Tools and engines
- **Venom Board in your game engine**: editor panels for Unreal Engine 5, Unity and Godot 4 list the cards assigned to you across your team projects, with status, due dates and disciplines, and let you start, finish or open them. The Unity and Godot panels are previews. Install steps are in [`integrations`](integrations)
- **MCP**: new `my_tasks` and `set_card_status` tools, and tools now see and set tags, tracked time, linked pull requests and card references, sprints and collapsed phases, crops and turns, comment replies and feedback pins, and can resolve threads

## [1.4.2] - 2026-10-08

### Planning
- **Circuit connectors**: a new wire style with straight runs and 45° bends, like Electric Nodes in Unreal. Pick it in the connector toolbar or the connector tool, or right-click the board → *Style every connector* to switch every wire at once
- **Reroute points**: right-click a connector → *Add a reroute point here* (or use + in its toolbar) and drag the dot to route the wire around things, Blueprint-style. Points snap into line with their neighbours so wires run straight (hold Ctrl to place freely), ride along when you move what the wire joins, and come with copies. Double-click a point to remove it, or *Straighten* to remove them all. Every connector style runs through them, and tools that support MCP can set them too

## [1.4.1] - 2026-10-08

### Reference board
- **Replace pictures and videos**: right-click a picture or video (or use ⇄ in its toolbar) → Replace, with a file or a link. The new one takes its place at the same width in its own shape, keeps its connectors and its settings (flip, greyscale, loop), and a picture can become a YouTube, Vimeo or video file and back. Undo puts the old one back, and in a team project everyone sees the swap straight away

### Teams
- **Connect tools (MCP) can do everything on a board**: besides planning, tools now lay out the board itself: text, frames (also wrapped around things), pictures and GIFs from a web address or the user's computer, YouTube and Vimeo videos, marker and highlighter ink (freehand, lines, arrows, rectangles, ellipses), connectors with every style, and the game jam clock, and replace any picture or video with another. They can change, move (frames carry what's inside), align, distribute, pack, stack, duplicate and delete anything, start projects from templates or add a template to a board, assign cards to teammates, trace dependencies, read comments, activity and search, look at the pictures on a board, rename projects, and save and restore versions. Inviting people, sharing, publishing and deleting projects stay in the app

## [1.4.0] - 2026-10-07

### Reference board
- **Import PureRef boards**: drop a `.pur` file on the board, or choose Import from PureRef, Trello, Jira or CSV in the menu. Boards from PureRef 1.x and 2.x come in with every picture in its place and at its size, rotated, flipped and cropped as it was; notes become text and groups become frames. The board lands next to what's already there, and in a team project its pictures upload for everyone. Pictures PureRef only linked to on disk and its drawings are counted and skipped

### Teams
- **Connect tools (MCP)**: tools that support the Model Context Protocol can work on your team boards: list projects, read a board with its phases and cards, read the schedule and critical path, create projects, add phases and cards with estimates, priorities, disciplines and dependencies, update and link cards, delete items and comment. Make an access token on your account page at venomboard.com (Settings → Account → Connect tools links there). A token acts as you, with your role in each team, so viewers' tokens can read and comment but not change a board. What a tool changes shows up live and stays in version history, and changing your password or signing out everywhere revokes every token

## [1.3.1] - 2026-10-07

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
