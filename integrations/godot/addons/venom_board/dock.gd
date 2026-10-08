@tool
extends VBoxContainer
## The Venom Board dock: the unfinished cards assigned to you across your team projects, grouped by project,
## soonest due first. Double-click a task to open it in the browser; Start and Done move it along.

const Client := preload("venom_client.gd")

const STATUS_NAMES := {"todo": "To do", "doing": "Doing", "blocked": "Blocked", "done": "Done"}
const DISCIPLINE_NAMES := {
	"code": "Code", "art": "Art", "design": "Design", "level": "Level design", "audio": "Audio", "ui": "UI/UX",
	"vfx": "VFX", "narr": "Narrative", "qa": "QA", "tech": "Tech/build", "mkt": "Marketing",
}
const PRIORITY_NAMES := {"must": "Must", "should": "Should", "could": "Could", "wont": "Won't"}
const KIND_NAMES := {"task": "Task", "bug": "Bug", "milestone": "Milestone", "idea": "Idea"}
const LATE_COLOR := Color("#ff2a4f")
const FILTER_ANY := 0
const FILTER_TODO := 1
const FILTER_DOING := 2
const FILTER_BLOCKED := 3
const FILTER_OVERDUE := 4
enum MenuId { OPEN, COPY_LINK, START, DONE, BLOCKED, TODO }

var _client: Client
var _tasks: Array = []       # rows from my_tasks, in the server's order (soonest due first)
var _projects: Array = []    # every project you can open, from the last my_tasks over all of them
var _loading := false
var _swatches := {}          # colour -> texture
var _menu_task: Dictionary = {}

var _refresh_button: Button
var _settings_button: Button
var _filter_edit: LineEdit
var _status_filter: OptionButton
var _project_pick: OptionButton
var _unassigned_check: CheckBox
var _settings_box: VBoxContainer
var _server_edit: LineEdit
var _token_edit: LineEdit
var _tree: Tree
var _start_button: Button
var _done_button: Button
var _message: Label
var _menu: PopupMenu


func _ready() -> void:
	_client = Client.new()
	add_child(_client)
	_client.load_settings()
	_build()
	_apply_theme()
	EditorInterface.get_editor_settings().settings_changed.connect(_on_editor_settings_changed)
	if _client.token.is_empty():
		_settings_button.button_pressed = true
		_say("Add your access token to see your tasks. Make one on your Venom Board account page, under Connect tools (MCP).")
	else:
		refresh()


func _notification(what: int) -> void:
	if what == NOTIFICATION_THEME_CHANGED:
		_apply_theme()


# ---------- building the dock ----------

func _build() -> void:
	var ui_scale := EditorInterface.get_editor_scale()
	custom_minimum_size = Vector2(240, 200) * ui_scale
	add_theme_constant_override("separation", int(4 * ui_scale))

	var bar := HBoxContainer.new()
	add_child(bar)
	_refresh_button = Button.new()
	_refresh_button.flat = true
	_refresh_button.tooltip_text = "Refresh"
	_refresh_button.pressed.connect(refresh)
	bar.add_child(_refresh_button)
	_filter_edit = LineEdit.new()
	_filter_edit.placeholder_text = "Filter tasks"
	_filter_edit.clear_button_enabled = true
	_filter_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_filter_edit.text_changed.connect(func(_text: String) -> void: _fill_tree())
	bar.add_child(_filter_edit)
	_status_filter = OptionButton.new()
	for label in ["Any status", "To do", "Doing", "Blocked", "Overdue"]:
		_status_filter.add_item(label)
	_status_filter.tooltip_text = "Show only tasks with this status"
	_status_filter.item_selected.connect(func(_index: int) -> void: _fill_tree())
	bar.add_child(_status_filter)
	_settings_button = Button.new()
	_settings_button.flat = true
	_settings_button.toggle_mode = true
	_settings_button.tooltip_text = "Server and access token"
	_settings_button.toggled.connect(func(on: bool) -> void: _settings_box.visible = on)
	bar.add_child(_settings_button)

	var scope := HBoxContainer.new()
	add_child(scope)
	_project_pick = OptionButton.new()
	_project_pick.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_project_pick.clip_text = true
	_project_pick.tooltip_text = "Show tasks from every project, or from one"
	_project_pick.item_selected.connect(_on_project_picked)
	scope.add_child(_project_pick)
	_unassigned_check = CheckBox.new()
	_unassigned_check.text = "Unassigned too"
	_unassigned_check.tooltip_text = "Also list this project's cards that nobody has taken yet"
	_unassigned_check.disabled = true
	_unassigned_check.toggled.connect(func(_on: bool) -> void: refresh())
	scope.add_child(_unassigned_check)
	_fill_projects()

	_settings_box = VBoxContainer.new()
	_settings_box.visible = false
	add_child(_settings_box)
	var grid := GridContainer.new()
	grid.columns = 2
	_settings_box.add_child(grid)
	var server_label := Label.new()
	server_label.text = "Server"
	grid.add_child(server_label)
	_server_edit = LineEdit.new()
	_server_edit.text = _client.server_url
	_server_edit.placeholder_text = Client.DEFAULT_SERVER
	_server_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	grid.add_child(_server_edit)
	var token_label := Label.new()
	token_label.text = "Token"
	grid.add_child(token_label)
	_token_edit = LineEdit.new()
	_token_edit.secret = true
	_token_edit.text = _client.token
	_token_edit.placeholder_text = "vbt_..."
	_token_edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_token_edit.text_submitted.connect(func(_text: String) -> void: _save_settings())
	grid.add_child(_token_edit)
	var buttons := HBoxContainer.new()
	_settings_box.add_child(buttons)
	var save := Button.new()
	save.text = "Save and connect"
	save.pressed.connect(_save_settings)
	buttons.add_child(save)
	var make := LinkButton.new()
	make.text = "Make a token"
	make.tooltip_text = "Opens your account page: Connect tools (MCP) makes a personal access token"
	make.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	make.pressed.connect(func() -> void: OS.shell_open(Client.account_page(_server_edit.text)))
	buttons.add_child(make)
	var note := Label.new()
	note.text = "Kept in this computer's editor settings, not in the project."
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	note.modulate = Color(1, 1, 1, 0.6)
	_settings_box.add_child(note)
	_settings_box.add_child(HSeparator.new())

	_tree = Tree.new()
	_tree.size_flags_vertical = Control.SIZE_EXPAND_FILL
	_tree.hide_root = true
	_tree.columns = 3
	_tree.column_titles_visible = true
	_tree.set_column_title(0, "Task")
	_tree.set_column_title(1, "Status")
	_tree.set_column_title(2, "Due")
	_tree.set_column_expand(0, true)
	_tree.set_column_expand(1, false)
	_tree.set_column_expand(2, false)
	_tree.set_column_custom_minimum_width(1, int(64 * ui_scale))
	_tree.set_column_custom_minimum_width(2, int(84 * ui_scale))
	_tree.select_mode = Tree.SELECT_ROW
	_tree.allow_rmb_select = true
	_tree.item_activated.connect(_on_item_activated)
	_tree.item_selected.connect(_update_buttons)
	_tree.nothing_selected.connect(_on_nothing_selected)
	_tree.item_mouse_selected.connect(_on_item_mouse_selected)
	add_child(_tree)

	var actions := HBoxContainer.new()
	add_child(actions)
	_start_button = Button.new()
	_start_button.text = "Start"
	_start_button.tooltip_text = "Set the selected card to Doing"
	_start_button.pressed.connect(func() -> void: _set_status(_selected_task(), "doing"))
	actions.add_child(_start_button)
	_done_button = Button.new()
	_done_button.text = "Done"
	_done_button.tooltip_text = "Mark the selected card done"
	_done_button.pressed.connect(func() -> void: _set_status(_selected_task(), "done"))
	actions.add_child(_done_button)
	_update_buttons()

	_message = Label.new()
	_message.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	add_child(_message)

	_menu = PopupMenu.new()
	_menu.id_pressed.connect(_on_menu_id_pressed)
	add_child(_menu)


func _apply_theme() -> void:
	if not is_instance_valid(_refresh_button):
		return
	_refresh_button.icon = get_theme_icon("Reload", "EditorIcons")
	_settings_button.icon = get_theme_icon("Tools", "EditorIcons")
	_filter_edit.right_icon = get_theme_icon("Search", "EditorIcons")


# ---------- talking to the server ----------

func refresh() -> void:
	if _loading:
		return
	var args := {"today": Time.get_date_string_from_system()}
	var project_id := _picked_project_id()
	if not project_id.is_empty():
		args["project_id"] = project_id
		if _unassigned_check.button_pressed:
			args["include_unassigned_in_project"] = true
	_set_loading(true)
	_client.call_tool("my_tasks", args, _on_tasks_loaded.bind(project_id))


func _on_tasks_loaded(result: Dictionary, error: String, project_id: String) -> void:
	_set_loading(false)
	if not error.is_empty():
		_say(error, true)
		return
	var tasks: Variant = result.get("tasks", [])
	_tasks = tasks if typeof(tasks) == TYPE_ARRAY else []
	if project_id.is_empty():
		var projects: Variant = result.get("projects", [])
		_projects = projects if typeof(projects) == TYPE_ARRAY else []
		_fill_projects()
	_fill_tree()
	var late := 0
	for t in _tasks:
		if bool(t.get("overdue", false)):
			late += 1
	var summary := "No unfinished tasks assigned to you." if _tasks.is_empty() else ("1 task" if _tasks.size() == 1 else "%d tasks" % _tasks.size())
	if late > 0:
		summary += ", %d overdue" % late
	if result.has("note"):
		summary += ". " + str(result["note"])
	_say("%s. Updated %s." % [summary.trim_suffix("."), Time.get_time_string_from_system().substr(0, 5)])


func _set_status(task: Dictionary, status: String) -> void:
	if task.is_empty() or _loading:
		return
	if not bool(task.get("can_edit", false)):
		_say("You can only view %s, so you can't change its cards." % str(task.get("project", "this project")), true)
		return
	_set_loading(true)
	var args := {"project_id": task["project_id"], "card_id": task["card_id"], "status": status, "today": Time.get_date_string_from_system()}
	_client.call_tool("set_card_status", args, _on_status_set.bind(str(task["project_id"]), str(task["card_id"])))


func _on_status_set(result: Dictionary, error: String, project_id: String, card_id: String) -> void:
	_set_loading(false)
	if not error.is_empty():
		_say(error, true)
		return
	var updated: Variant = result.get("task")
	if typeof(updated) != TYPE_DICTIONARY:
		refresh()
		return
	var index := _find_task(project_id, card_id)
	if index >= 0:
		if updated.get("status") == "done":
			_tasks.remove_at(index)
		else:
			_tasks[index] = updated
	_fill_tree()
	_select_task(project_id, card_id)
	var title := str(updated.get("title", "The card"))
	var said := {"doing": "Started “%s”.", "done": "“%s” is done.", "blocked": "“%s” is blocked.", "todo": "“%s” is back to do."}
	_say(str(said.get(updated.get("status"), "Updated “%s”.")) % title)


func _save_settings() -> void:
	var token := _token_edit.text.strip_edges()
	if not token.is_empty() and not Client.looks_like_token(token):
		_say("That doesn't look like a Venom Board access token: they start with vbt_. Copy the whole token from your account page.", true)
		return
	_client.server_url = Client.normalise_server(_server_edit.text)
	_client.token = token
	_client.save_settings()
	_server_edit.text = _client.server_url
	if token.is_empty():
		_tasks = []
		_fill_tree()
		_say("Token removed. Add one to see your tasks.")
		return
	_settings_button.button_pressed = false
	_projects = []
	_fill_projects()
	refresh()


func _on_editor_settings_changed() -> void:
	# someone changed the values in Editor Settings: follow them
	var server := _client.server_url
	var token := _client.token
	_client.load_settings()
	if server != _client.server_url or token != _client.token:
		_server_edit.text = _client.server_url
		_token_edit.text = _client.token
		if not _client.token.is_empty():
			refresh()


# ---------- the list ----------

func _fill_tree() -> void:
	var keep := _selected_task()
	_tree.clear()
	var root := _tree.create_item()
	var groups := {}
	for t in _tasks:
		if typeof(t) != TYPE_DICTIONARY or not _passes(t):
			continue
		var project_id := str(t.get("project_id", ""))
		var group: TreeItem = groups.get(project_id)
		if group == null:
			group = _tree.create_item(root)
			group.set_text(0, "%s · %s" % [str(t.get("project", "")), str(t.get("team", ""))])
			group.set_tooltip_text(0, str(t.get("project", "")))
			for c in 3:
				group.set_selectable(c, false)
			groups[project_id] = group
		var item := _tree.create_item(group)
		item.set_text(0, str(t.get("title", "")))
		item.set_icon(0, _swatch(str(t.get("color", ""))))
		item.set_tooltip_text(0, _describe(t))
		item.set_text(1, STATUS_NAMES.get(t.get("status"), str(t.get("status", ""))))
		item.set_text(2, _due_text(t))
		item.set_tooltip_text(2, str(t.get("due", "")))
		if bool(t.get("overdue", false)):
			item.set_custom_color(2, LATE_COLOR)
		if not bool(t.get("assigned_to_you", true)):
			item.set_suffix(0, "unassigned")
		item.set_metadata(0, t)
	for project_id in groups:
		var group: TreeItem = groups[project_id]
		group.set_text(1, str(group.get_child_count()))
	if groups.is_empty() and not _tasks.is_empty():
		var none := _tree.create_item(root)
		none.set_text(0, "Nothing matches the filter.")
		none.set_selectable(0, false)
		none.set_selectable(1, false)
		none.set_selectable(2, false)
	if not keep.is_empty():
		_select_task(str(keep.get("project_id", "")), str(keep.get("card_id", "")))
	_update_buttons()


func _passes(t: Dictionary) -> bool:
	var status := str(t.get("status", ""))
	var selected := _status_filter.selected
	if selected == FILTER_TODO and status != "todo":
		return false
	if selected == FILTER_DOING and status != "doing":
		return false
	if selected == FILTER_BLOCKED and status != "blocked":
		return false
	if selected == FILTER_OVERDUE and not bool(t.get("overdue", false)):
		return false
	var query := _filter_edit.text.strip_edges().to_lower()
	if query.is_empty():
		return true
	var haystack := " ".join(PackedStringArray([str(t.get("title", "")), str(t.get("project", "")), str(t.get("team", "")), str(t.get("phase", "")),
		str(DISCIPLINE_NAMES.get(t.get("discipline"), "")), str(KIND_NAMES.get(t.get("kind"), "")), str(PRIORITY_NAMES.get(t.get("priority"), ""))])).to_lower()
	for word in query.split(" ", false):
		if not haystack.contains(word):
			return false
	return true


func _due_text(t: Dictionary) -> String:
	var due := str(t.get("due", ""))
	var days: Variant = t.get("due_in_days")
	if due.is_empty() or days == null:
		return ""
	var d := int(days)
	if d < -1:
		return "%d days late" % -d
	if d == -1:
		return "1 day late"
	if d == 0:
		return "Today"
	if d == 1:
		return "Tomorrow"
	if d < 7:
		return "In %d days" % d
	return due


func _describe(t: Dictionary) -> String:
	var lines := PackedStringArray([str(t.get("title", ""))])
	var facts := PackedStringArray([KIND_NAMES.get(t.get("kind"), "Task")])
	if str(t.get("discipline", "")) != "":
		facts.append(DISCIPLINE_NAMES.get(t.get("discipline"), str(t.get("discipline"))))
	if str(t.get("priority", "")) != "":
		facts.append(PRIORITY_NAMES.get(t.get("priority"), str(t.get("priority"))))
	if str(t.get("severity", "")) != "":
		facts.append("Severity: " + str(t.get("severity")))
	if str(t.get("estimate", "")) != "":
		facts.append("Estimate " + str(t.get("estimate")))
	lines.append(", ".join(facts))
	if str(t.get("due", "")) != "":
		lines.append("Due " + str(t.get("due")) + (" (overdue)" if bool(t.get("overdue", false)) else ""))
	if str(t.get("phase", "")) != "":
		lines.append("Phase: " + str(t.get("phase")))
	var people: Variant = t.get("assignees", [])
	if typeof(people) == TYPE_ARRAY and not people.is_empty():
		lines.append("Assigned: " + ", ".join(PackedStringArray(people)))
	elif not bool(t.get("assigned_to_you", true)):
		lines.append("Nobody has taken this yet.")
	if not bool(t.get("can_edit", false)):
		lines.append("You can only view this project.")
	lines.append("Double-click to open it in the browser.")
	return "\n".join(lines)


func _swatch(hex: String) -> Texture2D:
	var color := Color.from_string(hex, Color("#9d99aa"))
	if _swatches.has(color):
		return _swatches[color]
	var gradient := Gradient.new()
	gradient.colors = PackedColorArray([color, color])
	var texture := GradientTexture2D.new()
	texture.gradient = gradient
	var side := maxi(8, int(10 * EditorInterface.get_editor_scale()))
	texture.width = side
	texture.height = side
	_swatches[color] = texture
	return texture


func _fill_projects() -> void:
	var keep := _picked_project_id()
	_project_pick.clear()
	_project_pick.add_item("All projects")
	_project_pick.set_item_metadata(0, "")
	for p in _projects:
		if typeof(p) != TYPE_DICTIONARY:
			continue
		var count := int(p.get("tasks", 0))
		_project_pick.add_item("%s · %s%s" % [str(p.get("project", "")), str(p.get("team", "")), " (%d)" % count if count > 0 else ""])
		var index := _project_pick.item_count - 1
		_project_pick.set_item_metadata(index, str(p.get("project_id", "")))
		if str(p.get("project_id", "")) == keep:
			_project_pick.select(index)
	if _project_pick.selected < 0:
		_project_pick.select(0)
	_unassigned_check.disabled = _picked_project_id().is_empty()


func _picked_project_id() -> String:
	if not is_instance_valid(_project_pick) or _project_pick.selected < 0:
		return ""
	return str(_project_pick.get_item_metadata(_project_pick.selected))


func _on_project_picked(_index: int) -> void:
	var one := not _picked_project_id().is_empty()
	_unassigned_check.disabled = not one
	if not one:
		_unassigned_check.set_pressed_no_signal(false)
	refresh()


func _selected_task() -> Dictionary:
	if not is_instance_valid(_tree):
		return {}
	var item := _tree.get_selected()
	if item == null:
		return {}
	var meta: Variant = item.get_metadata(0)
	return meta if typeof(meta) == TYPE_DICTIONARY else {}


func _find_task(project_id: String, card_id: String) -> int:
	for i in _tasks.size():
		var t: Variant = _tasks[i]
		if typeof(t) == TYPE_DICTIONARY and str(t.get("project_id")) == project_id and str(t.get("card_id")) == card_id:
			return i
	return -1


func _select_task(project_id: String, card_id: String) -> void:
	var root := _tree.get_root()
	if root == null:
		return
	for group in root.get_children():
		for item in group.get_children():
			var meta: Variant = item.get_metadata(0)
			if typeof(meta) == TYPE_DICTIONARY and str(meta.get("project_id")) == project_id and str(meta.get("card_id")) == card_id:
				item.select(0)
				_tree.scroll_to_item(item)
				return


func _update_buttons() -> void:
	var t := _selected_task()
	var editable := not t.is_empty() and bool(t.get("can_edit", false)) and not _loading
	_start_button.disabled = not editable or t.get("status") == "doing"
	_done_button.disabled = not editable
	var reason := "" if t.is_empty() or bool(t.get("can_edit", false)) else "\nYou can only view this project."
	_start_button.tooltip_text = "Set the selected card to Doing" + reason
	_done_button.tooltip_text = "Mark the selected card done" + reason


func _on_nothing_selected() -> void:
	_tree.deselect_all()
	_update_buttons()


func _on_item_activated() -> void:
	var t := _selected_task()
	if not t.is_empty():
		OS.shell_open(str(t.get("link", "")))


func _on_item_mouse_selected(mouse_position: Vector2, button: int) -> void:
	if button != MOUSE_BUTTON_RIGHT:
		return
	_menu_task = _selected_task()
	if _menu_task.is_empty():
		return
	var editable := bool(_menu_task.get("can_edit", false))
	var status := str(_menu_task.get("status", ""))
	_menu.clear()
	_menu.add_item("Open in browser", MenuId.OPEN)
	_menu.add_item("Copy link", MenuId.COPY_LINK)
	_menu.add_separator()
	_menu.add_item("Start (Doing)", MenuId.START)
	_menu.add_item("Mark done", MenuId.DONE)
	_menu.add_item("Mark blocked", MenuId.BLOCKED)
	_menu.add_item("Back to To do", MenuId.TODO)
	for pair in [[MenuId.START, "doing"], [MenuId.BLOCKED, "blocked"], [MenuId.TODO, "todo"]]:
		_menu.set_item_disabled(_menu.get_item_index(pair[0]), not editable or status == pair[1])
	_menu.set_item_disabled(_menu.get_item_index(MenuId.DONE), not editable)
	_menu.reset_size()
	_menu.popup(Rect2i(Vector2i(_tree.get_screen_position() + mouse_position), Vector2i.ZERO))


func _on_menu_id_pressed(id: int) -> void:
	var t := _menu_task
	if t.is_empty():
		return
	if id == MenuId.OPEN:
		OS.shell_open(str(t.get("link", "")))
	elif id == MenuId.COPY_LINK:
		DisplayServer.clipboard_set(str(t.get("link", "")))
		_say("Link copied.")
	elif id == MenuId.START:
		_set_status(t, "doing")
	elif id == MenuId.DONE:
		_set_status(t, "done")
	elif id == MenuId.BLOCKED:
		_set_status(t, "blocked")
	elif id == MenuId.TODO:
		_set_status(t, "todo")


func _set_loading(on: bool) -> void:
	_loading = on
	_refresh_button.disabled = on
	if on:
		_say("Loading…")
	_update_buttons()


func _say(text: String, is_error: bool = false) -> void:
	_message.text = text
	if is_error:
		_message.add_theme_color_override("font_color", LATE_COLOR)
	else:
		_message.remove_theme_color_override("font_color")
