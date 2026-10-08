@tool
extends Node
## Talks to a Venom Board server: JSON-RPC 2.0 "tools/call" requests to <server>/mcp, sent with a personal
## access token (Authorization: Bearer vbt_...). Each call gets its own HTTPRequest node, freed when it answers.
##
## Settings live in the editor settings of this computer (Editor > Editor Settings > Venom Board), never in
## the project, so the token can't end up in version control.

const SETTING_SERVER := "venom_board/server_url"
const SETTING_TOKEN := "venom_board/access_token"
const DEFAULT_SERVER := "https://venomboard.com"
const TIMEOUT_SECONDS := 20.0
const PROTOCOL_VERSION := "2025-06-18"
const TOKEN_PATTERN := "^vbt_[A-Za-z0-9_-]{20,80}$"

var server_url := DEFAULT_SERVER
var token := ""

var _next_id := 1


## Reads the server address and token from the editor settings, registering them on first use.
func load_settings() -> void:
	var es := EditorInterface.get_editor_settings()
	_define(es, SETTING_SERVER, DEFAULT_SERVER, PROPERTY_HINT_NONE)
	_define(es, SETTING_TOKEN, "", PROPERTY_HINT_PASSWORD)
	server_url = normalise_server(str(es.get_setting(SETTING_SERVER)))
	token = str(es.get_setting(SETTING_TOKEN)).strip_edges()


func save_settings() -> void:
	var es := EditorInterface.get_editor_settings()
	es.set_setting(SETTING_SERVER, server_url)
	es.set_setting(SETTING_TOKEN, token)


func _define(es: EditorSettings, key: String, default_value: String, hint: int) -> void:
	if not es.has_setting(key):
		es.set_setting(key, default_value)
	es.set_initial_value(key, default_value, false)
	es.add_property_info({"name": key, "type": TYPE_STRING, "hint": hint, "hint_string": ""})


## "venomboard.com/" -> "https://venomboard.com"
static func normalise_server(raw: String) -> String:
	var s := raw.strip_edges()
	if s.is_empty():
		return DEFAULT_SERVER
	if not (s.begins_with("http://") or s.begins_with("https://")):
		s = "https://" + s
	while s.ends_with("/"):
		s = s.substr(0, s.length() - 1)
	return s


static func looks_like_token(value: String) -> bool:
	var re := RegEx.new()
	re.compile(TOKEN_PATTERN)
	return re.search(value.strip_edges()) != null


func endpoint() -> String:
	return server_url + "/mcp"


## The account page section where personal access tokens are made.
static func account_page(server: String) -> String:
	return normalise_server(server) + "/account#mcp"


## Calls one tool. on_done is called once, as on_done.call(result: Dictionary, error: String): the tool's
## structuredContent and "" when it worked, or {} and a message to show when it didn't.
func call_tool(tool_name: String, arguments: Dictionary, on_done: Callable) -> void:
	if token.is_empty():
		on_done.call({}, "Add your access token in Settings to see your tasks.")
		return
	var http := HTTPRequest.new()
	http.timeout = TIMEOUT_SECONDS
	add_child(http)
	var message := {
		"jsonrpc": "2.0",
		"id": _next_id,
		"method": "tools/call",
		"params": {"name": tool_name, "arguments": arguments},
	}
	_next_id += 1
	var headers := PackedStringArray([
		"Content-Type: application/json",
		"Accept: application/json, text/event-stream",
		"MCP-Protocol-Version: " + PROTOCOL_VERSION,
		"Authorization: Bearer " + token,
	])
	http.request_completed.connect(_on_request_completed.bind(http, on_done), CONNECT_ONE_SHOT)
	var err := http.request(endpoint(), headers, HTTPClient.METHOD_POST, JSON.stringify(message))
	if err != OK:
		http.queue_free()
		on_done.call({}, "Couldn't send the request (%s). Check the server address in Settings." % error_string(err))


func _on_request_completed(result: int, code: int, _headers: PackedStringArray, body: PackedByteArray, http: HTTPRequest, on_done: Callable) -> void:
	http.queue_free()
	if result != HTTPRequest.RESULT_SUCCESS:
		on_done.call({}, _network_message(result))
		return
	var outcome := read_answer(code, body.get_string_from_utf8())
	on_done.call(outcome.result, outcome.error)


## Turns an HTTP status and body from /mcp into {"result": Dictionary, "error": String}.
func read_answer(code: int, text: String) -> Dictionary:
	var json := JSON.new()
	var data: Variant = json.data if json.parse(text) == OK else null
	if code == 401:
		return _fail("Check your token: the server didn't accept it. It may be mistyped, revoked, or made on another server. Make a new one on your account page under Connect tools (MCP).")
	if code == 429:
		return _fail("Too many requests. Wait a minute, then refresh.")
	if code == 403:
		return _fail("The server refused the request (403).")
	if code >= 500:
		return _fail("The server had a problem (HTTP %d). Try again in a moment." % code)
	if code != 200 or typeof(data) != TYPE_DICTIONARY:
		return _fail("Unexpected answer from %s (HTTP %d). Check the server address in Settings." % [server_url, code])
	if data.has("error") and typeof(data["error"]) == TYPE_DICTIONARY:
		var rpc_error: Dictionary = data["error"]
		if int(rpc_error.get("code", 0)) == -32602:
			return _fail("This server doesn't have the tools the panel needs yet. Check the server address, or update the server.")
		return _fail(str(rpc_error.get("message", "The server answered with an error.")))
	var res: Variant = data.get("result")
	if typeof(res) != TYPE_DICTIONARY:
		return _fail("Unexpected answer from the server.")
	if bool(res.get("isError", false)):
		return _fail(_content_text(res))
	var structured: Variant = res.get("structuredContent")
	if typeof(structured) != TYPE_DICTIONARY:
		return _fail("Unexpected answer from the server.")
	return {"result": structured, "error": ""}


func _fail(message: String) -> Dictionary:
	return {"result": {}, "error": message}


func _content_text(res: Dictionary) -> String:
	var content: Variant = res.get("content")
	if typeof(content) == TYPE_ARRAY:
		for part in content:
			if typeof(part) == TYPE_DICTIONARY and part.get("type") == "text":
				return str(part.get("text", ""))
	return "The server couldn't do that."


func _network_message(result: int) -> String:
	if result == HTTPRequest.RESULT_CANT_RESOLVE:
		return "Couldn't find %s. Check the server address in Settings." % server_url
	if result == HTTPRequest.RESULT_CANT_CONNECT or result == HTTPRequest.RESULT_CONNECTION_ERROR:
		return "Couldn't connect to %s. Check your connection and the server address." % server_url
	if result == HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
		return "Couldn't make a secure connection to %s." % server_url
	if result == HTTPRequest.RESULT_TIMEOUT:
		return "The server took too long to answer. Try again."
	if result == HTTPRequest.RESULT_NO_RESPONSE:
		return "The server didn't answer. Try again."
	if result == HTTPRequest.RESULT_REDIRECT_LIMIT_REACHED:
		return "The server address redirects too many times. Check it in Settings."
	return "The request failed (error %d). Try again." % result
