using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace VenomBoard.Editor
{
    /// <summary>
    /// Window > Venom Board: the unfinished cards assigned to you across your team projects, grouped by project and
    /// soonest due first. Double-click a task to open it in the browser; Start and Done move it along.
    /// </summary>
    public sealed class VenomBoardWindow : EditorWindow
    {
        static readonly string[] StatusFilterNames = { "Any status", "To do", "Doing", "Blocked", "Overdue" };
        static readonly Color LateColor = new Color(1f, 0.165f, 0.31f);
        static readonly Color Grey = new Color(0.616f, 0.6f, 0.667f);
        const float RowHeight = 22f;
        const float ButtonWidth = 46f;

        [SerializeField] List<VenomTask> tasks = new List<VenomTask>();
        [SerializeField] List<VenomProject> projects = new List<VenomProject>();
        [SerializeField] List<string> collapsed = new List<string>();
        [SerializeField] string filter = "";
        [SerializeField] StatusFilter statusFilter = StatusFilter.Any;
        [SerializeField] string projectId = "";
        [SerializeField] bool includeUnassigned;
        [SerializeField] bool showSettings;
        [SerializeField] string message = "";
        [SerializeField] bool messageIsError;
        [SerializeField] string selectedKey = "";
        [SerializeField] Vector2 scroll;
        [SerializeField] bool loadedOnce;

        [NonSerialized] VenomBoardClient client;
        [NonSerialized] bool loading;
        [NonSerialized] string serverField;
        [NonSerialized] string tokenField;
        [NonSerialized] GUIStyle groupStyle;
        [NonSerialized] GUIStyle lateStyle;
        [NonSerialized] GUIStyle dimStyle;

        [MenuItem("Window/Venom Board")]
        public static void Open()
        {
            var window = GetWindow<VenomBoardWindow>();
            window.titleContent = new GUIContent("Venom Board");
            window.minSize = new Vector2(300f, 200f);
            window.Show();
        }

        void OnEnable()
        {
            client = new VenomBoardClient();
            client.Load();
            serverField = client.ServerUrl;
            tokenField = client.Token;
            if (string.IsNullOrEmpty(client.Token))
            {
                showSettings = true;
                Say("Add your access token to see your tasks. Make one on your Venom Board account page, under Connect tools (MCP).", false);
            }
            else if (!loadedOnce)
            {
                Refresh();
            }
        }

        void OnGUI()
        {
            MakeStyles();
            DrawToolbar();
            if (showSettings) DrawSettings();
            DrawScope();
            DrawList();
            DrawMessage();
        }

        void MakeStyles()
        {
            if (groupStyle != null) return;
            groupStyle = new GUIStyle(EditorStyles.foldout) { fontStyle = FontStyle.Bold };
            lateStyle = new GUIStyle(EditorStyles.label);
            lateStyle.normal.textColor = LateColor;
            dimStyle = new GUIStyle(EditorStyles.label);
            dimStyle.normal.textColor = Grey;
        }

        // ---------- drawing ----------

        void DrawToolbar()
        {
            using (new EditorGUILayout.HorizontalScope(EditorStyles.toolbar))
            {
                using (new EditorGUI.DisabledScope(loading))
                {
                    var refresh = EditorGUIUtility.IconContent("Refresh");
                    refresh.tooltip = "Refresh";
                    if (GUILayout.Button(refresh, EditorStyles.toolbarButton, GUILayout.Width(28f))) Refresh();
                }
                filter = EditorGUILayout.TextField(filter, EditorStyles.toolbarSearchField, GUILayout.MinWidth(60f));
                statusFilter = (StatusFilter)EditorGUILayout.Popup((int)statusFilter, StatusFilterNames, EditorStyles.toolbarPopup, GUILayout.Width(90f));
                showSettings = GUILayout.Toggle(showSettings, new GUIContent("Settings", "Server and access token"), EditorStyles.toolbarButton, GUILayout.Width(60f));
            }
        }

        void DrawSettings()
        {
            using (new EditorGUILayout.VerticalScope(EditorStyles.helpBox))
            {
                serverField = EditorGUILayout.TextField(new GUIContent("Server", "Your Venom Board server"), serverField);
                tokenField = EditorGUILayout.PasswordField(new GUIContent("Access token", "A personal access token: vbt_..."), tokenField);
                using (new EditorGUILayout.HorizontalScope())
                {
                    if (GUILayout.Button("Save and connect", GUILayout.Width(130f))) SaveSettings();
                    GUILayout.Space(8f);
                    var make = new GUIContent("Make a token", "Opens your account page: Connect tools (MCP) makes a personal access token");
                    if (GUILayout.Button(make, EditorStyles.linkLabel)) Application.OpenURL(VenomProtocol.AccountPage(serverField));
                    EditorGUIUtility.AddCursorRect(GUILayoutUtility.GetLastRect(), MouseCursor.Link);
                    GUILayout.FlexibleSpace();
                }
                EditorGUILayout.LabelField("Kept in this computer's editor preferences, not in the project.", EditorStyles.miniLabel);
            }
        }

        void DrawScope()
        {
            using (new EditorGUILayout.HorizontalScope())
            {
                var names = new List<string> { "All projects" };
                int index = 0;
                for (int i = 0; i < projects.Count; i++)
                {
                    var p = projects[i];
                    names.Add((p.project + " · " + p.team + (p.tasks > 0 ? " (" + p.tasks + ")" : "")).Replace("/", "∕"));
                    if (p.projectId == projectId) index = i + 1;
                }
                if (index == 0 && projectId.Length > 0 && projects.Count > 0) projectId = "";
                using (new EditorGUI.DisabledScope(loading))
                {
                    int picked = EditorGUILayout.Popup(index, names.ToArray());
                    if (picked != index)
                    {
                        projectId = picked == 0 ? "" : projects[picked - 1].projectId;
                        if (projectId.Length == 0) includeUnassigned = false;
                        Refresh();
                    }
                    using (new EditorGUI.DisabledScope(projectId.Length == 0))
                    {
                        bool unassigned = GUILayout.Toggle(includeUnassigned, new GUIContent("Unassigned too", "Also list this project's cards that nobody has taken yet"), GUILayout.Width(110f));
                        if (unassigned != includeUnassigned)
                        {
                            includeUnassigned = unassigned;
                            Refresh();
                        }
                    }
                }
            }
        }

        void DrawList()
        {
            scroll = EditorGUILayout.BeginScrollView(scroll, GUILayout.ExpandHeight(true));
            var shown = new List<VenomTask>();
            foreach (var t in tasks) if (VenomProtocol.Matches(t, filter, statusFilter)) shown.Add(t);
            if (shown.Count == 0 && tasks.Count > 0) EditorGUILayout.LabelField("Nothing matches the filter.", dimStyle);
            // groups in the order their soonest task comes, tasks in the server's order inside each
            var order = new List<string>();
            var groups = new Dictionary<string, List<VenomTask>>();
            foreach (var t in shown)
            {
                List<VenomTask> list;
                if (!groups.TryGetValue(t.projectId, out list))
                {
                    list = new List<VenomTask>();
                    groups[t.projectId] = list;
                    order.Add(t.projectId);
                }
                list.Add(t);
            }
            foreach (var id in order)
            {
                var list = groups[id];
                bool open = !collapsed.Contains(id);
                bool now = EditorGUILayout.Foldout(open, list[0].project + " · " + list[0].team + "  (" + list.Count + ")", true, groupStyle);
                if (now != open)
                {
                    if (now) collapsed.Remove(id);
                    else collapsed.Add(id);
                }
                if (!now) continue;
                foreach (var t in list) DrawRow(t);
            }
            EditorGUILayout.EndScrollView();
        }

        void DrawRow(VenomTask t)
        {
            Rect row = EditorGUILayout.GetControlRect(false, RowHeight);
            row.xMin += 12f;
            bool selected = t.Key == selectedKey;
            if (selected && Event.current.type == EventType.Repaint)
                EditorGUI.DrawRect(row, EditorGUIUtility.isProSkin ? new Color(0.17f, 0.36f, 0.53f) : new Color(0.23f, 0.45f, 0.69f, 0.35f));

            var done = new Rect(row.xMax - ButtonWidth, row.y + 2f, ButtonWidth, row.height - 4f);
            var start = new Rect(done.x - ButtonWidth - 2f, done.y, ButtonWidth, done.height);
            var due = new Rect(start.x - 88f, row.y, 84f, row.height);
            var status = new Rect(due.x - 62f, row.y, 60f, row.height);
            var swatch = new Rect(row.x + 2f, row.y + (row.height - 10f) / 2f, 10f, 10f);
            var title = new Rect(swatch.xMax + 6f, row.y, Mathf.Max(20f, status.x - swatch.xMax - 10f), row.height);

            using (new EditorGUI.DisabledScope(!t.canEdit || loading))
            {
                string why = t.canEdit ? "" : "\nYou can only view this project.";
                using (new EditorGUI.DisabledScope(t.status == "doing"))
                {
                    if (GUI.Button(start, new GUIContent("Start", "Set this card to Doing" + why), EditorStyles.miniButtonLeft)) SetStatus(t, "doing");
                }
                if (GUI.Button(done, new GUIContent("Done", "Mark this card done" + why), EditorStyles.miniButtonRight)) SetStatus(t, "done");
            }

            if (Event.current.type == EventType.Repaint) EditorGUI.DrawRect(swatch, ParseColor(t.color));
            string text = t.title + (t.assignedToYou ? "" : "  (unassigned)");
            EditorGUI.LabelField(title, new GUIContent(text, VenomProtocol.Describe(t)));
            EditorGUI.LabelField(status, VenomProtocol.Name(VenomProtocol.StatusNames, t.status), dimStyle);
            EditorGUI.LabelField(due, new GUIContent(VenomProtocol.DueText(t), t.due), t.overdue ? lateStyle : EditorStyles.label);

            // clicks on the row itself (the buttons have already taken theirs)
            var e = Event.current;
            if (!row.Contains(e.mousePosition)) return;
            if (e.type == EventType.MouseDown && e.button == 0)
            {
                selectedKey = t.Key;
                if (e.clickCount == 2) Application.OpenURL(t.link);
                e.Use();
                Repaint();
            }
            else if (e.type == EventType.ContextClick)
            {
                selectedKey = t.Key;
                ShowMenu(t);
                e.Use();
            }
        }

        void ShowMenu(VenomTask t)
        {
            var menu = new GenericMenu();
            menu.AddItem(new GUIContent("Open in browser"), false, () => Application.OpenURL(t.link));
            menu.AddItem(new GUIContent("Copy link"), false, () => { EditorGUIUtility.systemCopyBuffer = t.link; Say("Link copied.", false); });
            menu.AddSeparator("");
            AddStatus(menu, t, "Start (Doing)", "doing");
            AddStatus(menu, t, "Mark done", "done");
            AddStatus(menu, t, "Mark blocked", "blocked");
            AddStatus(menu, t, "Back to To do", "todo");
            menu.ShowAsContext();
        }

        void AddStatus(GenericMenu menu, VenomTask t, string label, string status)
        {
            if (t.canEdit && !loading && (t.status != status || status == "done")) menu.AddItem(new GUIContent(label), false, () => SetStatus(t, status));
            else menu.AddDisabledItem(new GUIContent(label));
        }

        void DrawMessage()
        {
            if (string.IsNullOrEmpty(message)) return;
            if (messageIsError) EditorGUILayout.HelpBox(message, MessageType.Error);
            else EditorGUILayout.LabelField(message, EditorStyles.wordWrappedMiniLabel);
        }

        static Color ParseColor(string hex)
        {
            Color c;
            return !string.IsNullOrEmpty(hex) && ColorUtility.TryParseHtmlString(hex, out c) ? c : Grey;
        }

        // ---------- talking to the server ----------

        void Refresh()
        {
            if (loading) return;
            loading = true;
            Say("Loading…", false);
            string asked = projectId;
            client.CallTool("my_tasks", VenomProtocol.MyTasksArguments(VenomProtocol.Today(), asked, includeUnassigned), outcome =>
            {
                if (this == null) return;  // the window was closed meanwhile
                loading = false;
                if (!outcome.Ok)
                {
                    Say(outcome.Error, true);
                    Repaint();
                    return;
                }
                var list = VenomProtocol.ReadTasks(outcome.Result);
                tasks = list.Tasks;
                if (asked.Length == 0) projects = list.Projects;
                loadedOnce = true;
                int late = 0;
                foreach (var t in tasks) if (t.overdue) late++;
                string summary = tasks.Count == 0 ? "No unfinished tasks assigned to you" : tasks.Count == 1 ? "1 task" : tasks.Count + " tasks";
                if (late > 0) summary += ", " + late + " overdue";
                if (list.Note.Length > 0) summary += ". " + list.Note.TrimEnd('.');
                Say(summary + ". Updated " + DateTime.Now.ToString("HH:mm") + ".", false);
                Repaint();
            });
        }

        void SetStatus(VenomTask t, string status)
        {
            if (loading) return;
            if (!t.canEdit)
            {
                Say("You can only view " + t.project + ", so you can't change its cards.", true);
                return;
            }
            loading = true;
            Say("Saving…", false);
            string key = t.Key;
            client.CallTool("set_card_status", VenomProtocol.SetStatusArguments(t, status, VenomProtocol.Today()), outcome =>
            {
                if (this == null) return;
                loading = false;
                if (!outcome.Ok)
                {
                    Say(outcome.Error, true);
                    Repaint();
                    return;
                }
                object row;
                var updated = outcome.Result.TryGetValue("task", out row) && row is Dictionary<string, object> ? VenomProtocol.ReadTask((Dictionary<string, object>)row) : null;
                if (updated == null)
                {
                    Refresh();
                    return;
                }
                int at = tasks.FindIndex(x => x.Key == key);
                if (at >= 0)
                {
                    if (updated.status == "done") tasks.RemoveAt(at);
                    else tasks[at] = updated;
                }
                Say(VenomProtocol.StatusChanged(updated), false);
                Repaint();
            });
        }

        void SaveSettings()
        {
            string token = (tokenField ?? "").Trim();
            if (token.Length > 0 && !VenomProtocol.LooksLikeToken(token))
            {
                Say("That doesn't look like a Venom Board access token: they start with vbt_. Copy the whole token from your account page.", true);
                return;
            }
            client.ServerUrl = VenomProtocol.NormaliseServer(serverField);
            client.Token = token;
            client.Save();
            serverField = client.ServerUrl;
            GUI.FocusControl(null);
            if (token.Length == 0)
            {
                tasks.Clear();
                projects.Clear();
                Say("Token removed. Add one to see your tasks.", false);
                return;
            }
            showSettings = false;
            projects.Clear();
            projectId = "";
            Refresh();
        }

        void Say(string text, bool isError)
        {
            message = text;
            messageIsError = isError;
        }
    }
}
