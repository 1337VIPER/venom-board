using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace VenomBoard.Editor
{
    /// <summary>One unfinished card from my_tasks.</summary>
    [Serializable]
    public class VenomTask
    {
        public string projectId = "";
        public string project = "";
        public string team = "";
        public bool canEdit;
        public string cardId = "";
        public string title = "";
        public string kind = "task";
        public string status = "todo";
        public string priority = "";
        public string discipline = "";
        public string estimate = "";
        public string due = "";
        public bool hasDueInDays;
        public int dueInDays;
        public bool overdue;
        public string severity = "";
        public string phase = "";
        public string color = "";
        public bool assignedToYou = true;
        public List<string> assignees = new List<string>();
        public string link = "";

        public string Key => projectId + "/" + cardId;
    }

    /// <summary>A project you can open, with how many of your tasks it holds.</summary>
    [Serializable]
    public class VenomProject
    {
        public string projectId = "";
        public string project = "";
        public string team = "";
        public bool canEdit;
        public int tasks;
    }

    public sealed class TaskList
    {
        public string Today = "";
        public string Note = "";
        public List<VenomTask> Tasks = new List<VenomTask>();
        public List<VenomProject> Projects = new List<VenomProject>();
    }

    /// <summary>What a tool call came back with: the tool's structuredContent, or a message to show.</summary>
    public sealed class RpcOutcome
    {
        public Dictionary<string, object> Result;
        public string Error;
        public bool Ok => Error == null;

        public static RpcOutcome Fail(string message) => new RpcOutcome { Error = message };
        public static RpcOutcome Success(Dictionary<string, object> result) => new RpcOutcome { Result = result };
    }

    public enum StatusFilter { Any, ToDo, Doing, Blocked, Overdue }

    /// <summary>
    /// The Venom Board MCP endpoint as the panel uses it: JSON-RPC 2.0 "tools/call" requests POSTed to
    /// &lt;server&gt;/mcp with "Authorization: Bearer vbt_...", answered with one JSON object. No Unity types here,
    /// so it can be tested outside the editor.
    /// </summary>
    public static class VenomProtocol
    {
        public const string DefaultServer = "https://venomboard.com";
        public const string ProtocolVersion = "2025-06-18";
        public const int TimeoutSeconds = 20;
        static readonly Regex TokenPattern = new Regex("^vbt_[A-Za-z0-9_-]{20,80}$");

        public static readonly Dictionary<string, string> StatusNames = new Dictionary<string, string>
        {
            { "todo", "To do" }, { "doing", "Doing" }, { "blocked", "Blocked" }, { "done", "Done" },
        };
        public static readonly Dictionary<string, string> DisciplineNames = new Dictionary<string, string>
        {
            { "code", "Code" }, { "art", "Art" }, { "design", "Design" }, { "level", "Level design" }, { "audio", "Audio" }, { "ui", "UI/UX" },
            { "vfx", "VFX" }, { "narr", "Narrative" }, { "qa", "QA" }, { "tech", "Tech/build" }, { "mkt", "Marketing" },
        };
        public static readonly Dictionary<string, string> PriorityNames = new Dictionary<string, string>
        {
            { "must", "Must" }, { "should", "Should" }, { "could", "Could" }, { "wont", "Won't" },
        };
        public static readonly Dictionary<string, string> KindNames = new Dictionary<string, string>
        {
            { "task", "Task" }, { "bug", "Bug" }, { "milestone", "Milestone" }, { "idea", "Idea" },
        };

        /// <summary>"venomboard.com/" becomes "https://venomboard.com".</summary>
        public static string NormaliseServer(string raw)
        {
            string s = (raw ?? "").Trim();
            if (s.Length == 0) return DefaultServer;
            if (!s.StartsWith("http://", StringComparison.OrdinalIgnoreCase) && !s.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) s = "https://" + s;
            return s.TrimEnd('/');
        }

        public static bool LooksLikeToken(string value) => TokenPattern.IsMatch((value ?? "").Trim());

        public static string Endpoint(string server) => NormaliseServer(server) + "/mcp";

        public static string AccountPage(string server) => NormaliseServer(server) + "/account#mcp";

        /// <summary>Today's date on this computer, for due_in_days and overdue.</summary>
        public static string Today() => DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        public static string ToolCall(int id, string tool, Dictionary<string, object> arguments)
        {
            return MiniJson.Serialize(new Dictionary<string, object>
            {
                { "jsonrpc", "2.0" },
                { "id", id },
                { "method", "tools/call" },
                { "params", new Dictionary<string, object> { { "name", tool }, { "arguments", arguments ?? new Dictionary<string, object>() } } },
            });
        }

        public static Dictionary<string, object> MyTasksArguments(string today, string projectId, bool includeUnassigned)
        {
            var args = new Dictionary<string, object> { { "today", today } };
            if (!string.IsNullOrEmpty(projectId))
            {
                args["project_id"] = projectId;
                if (includeUnassigned) args["include_unassigned_in_project"] = true;
            }
            return args;
        }

        public static Dictionary<string, object> SetStatusArguments(VenomTask task, string status, string today)
        {
            return new Dictionary<string, object> { { "project_id", task.projectId }, { "card_id", task.cardId }, { "status", status }, { "today", today } };
        }

        /// <summary>
        /// Reads what /mcp answered. networkError is set when no HTTP answer came back at all.
        /// </summary>
        public static RpcOutcome ReadAnswer(long httpStatus, string body, string networkError, string server)
        {
            string where = NormaliseServer(server);
            if (!string.IsNullOrEmpty(networkError)) return RpcOutcome.Fail(NetworkMessage(networkError, where));
            if (httpStatus == 401)
                return RpcOutcome.Fail("Check your token: the server didn't accept it. It may be mistyped, revoked, or made on another server. Make a new one on your account page under Connect tools (MCP).");
            if (httpStatus == 429) return RpcOutcome.Fail("Too many requests. Wait a minute, then refresh.");
            if (httpStatus == 403) return RpcOutcome.Fail("The server refused the request (403).");
            if (httpStatus >= 500) return RpcOutcome.Fail("The server had a problem (HTTP " + httpStatus + "). Try again in a moment.");
            object parsed;
            var data = httpStatus == 200 && MiniJson.TryParse(body, out parsed) ? parsed as Dictionary<string, object> : null;
            if (data == null) return RpcOutcome.Fail("Unexpected answer from " + where + " (HTTP " + httpStatus + "). Check the server address in Settings.");
            object errorValue;
            if (data.TryGetValue("error", out errorValue) && errorValue is Dictionary<string, object>)
            {
                var error = (Dictionary<string, object>)errorValue;
                if (Long(error, "code") == -32602) return RpcOutcome.Fail("This server doesn't have the tools the panel needs yet. Check the server address, or update the server.");
                string message = Str(error, "message");
                return RpcOutcome.Fail(message.Length > 0 ? message : "The server answered with an error.");
            }
            object resultValue;
            var result = data.TryGetValue("result", out resultValue) ? resultValue as Dictionary<string, object> : null;
            if (result == null) return RpcOutcome.Fail("Unexpected answer from the server.");
            if (Bool(result, "isError")) return RpcOutcome.Fail(ContentText(result));
            object structured;
            var content = result.TryGetValue("structuredContent", out structured) ? structured as Dictionary<string, object> : null;
            return content != null ? RpcOutcome.Success(content) : RpcOutcome.Fail("Unexpected answer from the server.");
        }

        static string ContentText(Dictionary<string, object> result)
        {
            object content;
            if (result.TryGetValue("content", out content) && content is List<object>)
            {
                foreach (var part in (List<object>)content)
                {
                    var p = part as Dictionary<string, object>;
                    if (p != null && Str(p, "type") == "text") return Str(p, "text");
                }
            }
            return "The server couldn't do that.";
        }

        static string NetworkMessage(string error, string server)
        {
            string e = error.ToLowerInvariant();
            if (e.Contains("resolve")) return "Couldn't find " + server + ". Check the server address in Settings.";
            if (e.Contains("timeout") || e.Contains("timed out")) return "The server took too long to answer. Try again.";
            if (e.Contains("ssl") || e.Contains("tls") || e.Contains("certificate")) return "Couldn't make a secure connection to " + server + ".";
            return "Couldn't connect to " + server + " (" + error + "). Check your connection and the server address.";
        }

        public static TaskList ReadTasks(Dictionary<string, object> content)
        {
            var list = new TaskList { Today = Str(content, "today"), Note = Str(content, "note") };
            foreach (var row in Rows(content, "tasks")) list.Tasks.Add(ReadTask(row));
            foreach (var row in Rows(content, "projects"))
            {
                list.Projects.Add(new VenomProject
                {
                    projectId = Str(row, "project_id"), project = Str(row, "project"), team = Str(row, "team"),
                    canEdit = Bool(row, "can_edit"), tasks = (int)Long(row, "tasks"),
                });
            }
            return list;
        }

        public static VenomTask ReadTask(Dictionary<string, object> row)
        {
            var task = new VenomTask
            {
                projectId = Str(row, "project_id"), project = Str(row, "project"), team = Str(row, "team"), canEdit = Bool(row, "can_edit"),
                cardId = Str(row, "card_id"), title = Str(row, "title"), kind = Str(row, "kind"), status = Str(row, "status"),
                priority = Str(row, "priority"), discipline = Str(row, "discipline"), estimate = Str(row, "estimate"), due = Str(row, "due"),
                overdue = Bool(row, "overdue"), severity = Str(row, "severity"), phase = Str(row, "phase"), color = Str(row, "color"),
                assignedToYou = !row.ContainsKey("assigned_to_you") || Bool(row, "assigned_to_you"), link = Str(row, "link"),
            };
            object days;
            if (row.TryGetValue("due_in_days", out days) && (days is long || days is double))
            {
                task.hasDueInDays = true;
                task.dueInDays = (int)Math.Round(Convert.ToDouble(days, CultureInfo.InvariantCulture));
            }
            object people;
            if (row.TryGetValue("assignees", out people) && people is List<object>)
                foreach (var p in (List<object>)people) if (p is string) task.assignees.Add((string)p);
            return task;
        }

        /// <summary>"3 days late", "Today", "Tomorrow", "In 4 days" or the date.</summary>
        public static string DueText(VenomTask t)
        {
            if (string.IsNullOrEmpty(t.due) || !t.hasDueInDays) return "";
            int d = t.dueInDays;
            if (d < -1) return (-d) + " days late";
            if (d == -1) return "1 day late";
            if (d == 0) return "Today";
            if (d == 1) return "Tomorrow";
            if (d < 7) return "In " + d + " days";
            return t.due;
        }

        public static bool Matches(VenomTask t, string query, StatusFilter filter)
        {
            switch (filter)
            {
                case StatusFilter.ToDo: if (t.status != "todo") return false; break;
                case StatusFilter.Doing: if (t.status != "doing") return false; break;
                case StatusFilter.Blocked: if (t.status != "blocked") return false; break;
                case StatusFilter.Overdue: if (!t.overdue) return false; break;
            }
            string q = (query ?? "").Trim().ToLowerInvariant();
            if (q.Length == 0) return true;
            string haystack = string.Join(" ", new[] { t.title, t.project, t.team, t.phase, Name(DisciplineNames, t.discipline), Name(KindNames, t.kind), Name(PriorityNames, t.priority) }).ToLowerInvariant();
            foreach (var word in q.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries))
                if (haystack.IndexOf(word, StringComparison.Ordinal) < 0) return false;
            return true;
        }

        public static string Describe(VenomTask t)
        {
            var facts = new List<string> { Name(KindNames, t.kind) };
            if (t.discipline.Length > 0) facts.Add(Name(DisciplineNames, t.discipline));
            if (t.priority.Length > 0) facts.Add(Name(PriorityNames, t.priority));
            if (t.severity.Length > 0) facts.Add("Severity: " + t.severity);
            if (t.estimate.Length > 0) facts.Add("Estimate " + t.estimate);
            var lines = new List<string> { t.title, string.Join(", ", facts.ToArray()) };
            if (t.due.Length > 0) lines.Add("Due " + t.due + (t.overdue ? " (overdue)" : ""));
            if (t.phase.Length > 0) lines.Add("Phase: " + t.phase);
            if (t.assignees.Count > 0) lines.Add("Assigned: " + string.Join(", ", t.assignees.ToArray()));
            else if (!t.assignedToYou) lines.Add("Nobody has taken this yet.");
            if (!t.canEdit) lines.Add("You can only view this project.");
            lines.Add("Double-click to open it in the browser.");
            return string.Join("\n", lines.ToArray());
        }

        public static string StatusChanged(VenomTask t)
        {
            switch (t.status)
            {
                case "doing": return "Started “" + t.title + "”.";
                case "done": return "“" + t.title + "” is done.";
                case "blocked": return "“" + t.title + "” is blocked.";
                case "todo": return "“" + t.title + "” is back to do.";
                default: return "Updated “" + t.title + "”.";
            }
        }

        public static string Name(Dictionary<string, string> names, string key)
        {
            string name;
            return key != null && names.TryGetValue(key, out name) ? name : key ?? "";
        }

        static IEnumerable<Dictionary<string, object>> Rows(Dictionary<string, object> content, string key)
        {
            object value;
            if (!content.TryGetValue(key, out value) || !(value is List<object>)) yield break;
            foreach (var item in (List<object>)value)
            {
                var row = item as Dictionary<string, object>;
                if (row != null) yield return row;
            }
        }

        static string Str(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : "";
        }

        static bool Bool(Dictionary<string, object> d, string key)
        {
            object v;
            return d.TryGetValue(key, out v) && v is bool && (bool)v;
        }

        static long Long(Dictionary<string, object> d, string key)
        {
            object v;
            if (!d.TryGetValue(key, out v)) return 0;
            if (v is long) return (long)v;
            if (v is double) return (long)Math.Round((double)v);
            return 0;
        }
    }
}
