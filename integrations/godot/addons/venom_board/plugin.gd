@tool
extends EditorPlugin
## Adds the Venom Board dock to the editor.

const Dock := preload("dock.gd")

var _dock: Control


func _enter_tree() -> void:
	_dock = Dock.new()
	_dock.name = "Venom Board"
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)


func _exit_tree() -> void:
	if is_instance_valid(_dock):
		remove_control_from_docks(_dock)
		_dock.queue_free()
	_dock = null


func _get_plugin_name() -> String:
	return "Venom Board"
