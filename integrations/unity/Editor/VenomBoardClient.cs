using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Networking;

namespace VenomBoard.Editor
{
    /// <summary>
    /// Sends tool calls to the Venom Board server with UnityWebRequest and hands the answers back on the main
    /// thread. The server address and token are kept in EditorPrefs: per user on this computer, never in the project.
    /// </summary>
    public sealed class VenomBoardClient
    {
        public const string ServerKey = "VenomBoard.ServerUrl";
        public const string TokenKey = "VenomBoard.AccessToken";

        sealed class Pending
        {
            public UnityWebRequest Request;
            public Action<RpcOutcome> Done;
            public string Server;
        }

        static readonly List<Pending> pending = new List<Pending>();
        static int nextId = 1;

        public string ServerUrl = VenomProtocol.DefaultServer;
        public string Token = "";

        public void Load()
        {
            ServerUrl = VenomProtocol.NormaliseServer(EditorPrefs.GetString(ServerKey, VenomProtocol.DefaultServer));
            Token = EditorPrefs.GetString(TokenKey, "").Trim();
        }

        public void Save()
        {
            EditorPrefs.SetString(ServerKey, ServerUrl);
            if (string.IsNullOrEmpty(Token)) EditorPrefs.DeleteKey(TokenKey);
            else EditorPrefs.SetString(TokenKey, Token);
        }

        /// <summary>Calls one tool; done runs once on the main thread with the result or a message to show.</summary>
        public void CallTool(string tool, Dictionary<string, object> arguments, Action<RpcOutcome> done)
        {
            if (string.IsNullOrEmpty(Token))
            {
                done(RpcOutcome.Fail("Add your access token in Settings to see your tasks."));
                return;
            }
            byte[] body = Encoding.UTF8.GetBytes(VenomProtocol.ToolCall(nextId++, tool, arguments));
            var request = new UnityWebRequest(VenomProtocol.Endpoint(ServerUrl), UnityWebRequest.kHttpVerbPOST);
            request.uploadHandler = new UploadHandlerRaw(body) { contentType = "application/json" };
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Accept", "application/json, text/event-stream");
            request.SetRequestHeader("MCP-Protocol-Version", VenomProtocol.ProtocolVersion);
            request.SetRequestHeader("Authorization", "Bearer " + Token);
            request.timeout = VenomProtocol.TimeoutSeconds;
            request.SendWebRequest();
            if (pending.Count == 0) EditorApplication.update += Pump;
            pending.Add(new Pending { Request = request, Done = done, Server = ServerUrl });
        }

        // EditorApplication.update runs whether or not the game is playing, so answers arrive in edit mode too
        static void Pump()
        {
            for (int i = pending.Count - 1; i >= 0; i--)
            {
                var p = pending[i];
                if (!p.Request.isDone) continue;
                pending.RemoveAt(i);
                RpcOutcome outcome;
                try
                {
                    bool noAnswer = p.Request.result == UnityWebRequest.Result.ConnectionError;
                    string text = p.Request.downloadHandler != null ? p.Request.downloadHandler.text : "";
                    outcome = VenomProtocol.ReadAnswer(p.Request.responseCode, text, noAnswer ? p.Request.error ?? "no answer" : null, p.Server);
                }
                finally
                {
                    p.Request.Dispose();
                }
                try
                {
                    p.Done(outcome);
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                }
            }
            if (pending.Count == 0) EditorApplication.update -= Pump;
        }
    }
}
