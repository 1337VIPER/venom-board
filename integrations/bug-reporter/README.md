# In-game bug reporter

Let players report bugs from inside your game. Each report lands on your team's Venom Board project as a bug card
in a **Bug reports** frame, with the player's screenshot next to it and the end of your log in its notes. Everyone
with the board open sees it arrive.

Below: how to get a key, the request, and ready-to-paste code for [curl](#curl), [Godot 4](#godot-4-gdscript),
[Unity](#unity-c) and [Unreal Engine 5](#unreal-engine-5-c).

## Get a report key

1. Open the project in Venom Board and open the **Team** panel.
2. Under **In-game bug reporter**, choose **Create a report key** (team admins can do this).
3. Copy the key, which starts with `vbr_`. It's only shown once.

A key only sends reports to that one project. Anyone who has the key can send reports with it, and a key inside a
shipped game can be dug out by a player who looks for it. If that happens, choose **New key** (the old one stops
working straight away) or **Revoke**.

Cards from the bug reporter are kept off the project's public roadmap until you choose to show them.

## The request

```
POST https://venomboard.com/api/report
Authorization: Bearer vbr_your_key_here
Content-Type: application/json
```

The body is one JSON object:

| Field | Required | What to send |
| --- | --- | --- |
| `title` | yes | A short line saying what went wrong. Up to 120 characters; longer titles are cut. |
| `description` | no | What happened. Up to 4,000 characters; longer text is cut. |
| `severity` | no | `crash`, `major`, `minor` or `polish`. Leave it out for `major`. |
| `version` | no | Your game's version or build, up to 60 characters. |
| `platform` | no | Where it's running, like `Windows 11` or `Steam Deck`. Up to 60 characters. |
| `reporter` | no | The player's name, if they want to give it. Up to 40 characters. |
| `log` | no | The end of your log file, up to 65,536 characters. Its last lines go at the end of the card's notes, so the card stays readable on the board. |
| `screenshot` | no | A PNG or JPEG (WebP works too), as base64 or a `data:image/…;base64,` address. Up to 5 MB before encoding. |

The whole request can be up to 8 MB. Games running in a browser (web builds) can send reports too.

### Answers

A report that went through gets `200`:

```json
{ "ok": true, "status": "created" }
```

If a bug with the same title (ignoring case, spaces and punctuation) was reported in the last 24 hours and its card
is still on the board, no new card is made. A comment goes on that card instead, like *"Reported again: version
1.0.1, platform Linux."*, with the new description. The repeat's screenshot and log aren't kept.

```json
{ "ok": true, "status": "repeat", "reports": 3 }
```

Anything else is an error with a message saying what to fix:

```json
{ "error": "severity is one of crash, major, minor or polish.", "code": "severity" }
```

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `title`, `severity`, `bad_field`, `screenshot`, `bad_json` | A field is missing or isn't what it should be, or the body isn't valid JSON. |
| 401 | `no_key`, `bad_key` | The `Authorization` header is missing, or the key was revoked or replaced. |
| 413 | `too_large`, `log_too_big`, `screenshot_too_big` | Something is over its size limit. |
| 415 | `type`, `screenshot_type` | The body isn't sent as JSON, or the screenshot isn't a PNG, JPEG or WebP. |
| 429 | `rate` | Too many reports in a short time. Wait a minute before sending more. |
| 507 | `board_full`, `quota` | The project's board, or the team's storage, is full. |

Reports are limited for each key and each player. Send them in the background, never hold up the game waiting for
one, and don't retry in a loop: if you get `429`, drop the report or try once more a minute later.

## curl

```sh
curl https://venomboard.com/api/report \
  -H "Authorization: Bearer vbr_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{"title": "Fell through the floor in the cave", "description": "Jumped at the ledge by the waterfall.", "severity": "major", "version": "0.4.2", "platform": "Windows 11"}'
```

With a screenshot (macOS or Linux):

```sh
printf '{"title": "Texture flicker on the bridge", "severity": "polish", "screenshot": "%s"}' \
  "$(base64 < shot.png | tr -d '\n')" > report.json
curl https://venomboard.com/api/report \
  -H "Authorization: Bearer vbr_your_key_here" \
  -H "Content-Type: application/json" \
  --data-binary @report.json
```

On Windows PowerShell, write `curl.exe` instead of `curl`.

## Godot 4 (GDScript)

Save this as `bug_reporter.gd`, add it as an autoload named `BugReporter` (Project → Project Settings → Globals →
Autoload), and call `BugReporter.send_report("Fell through the floor", "Near the waterfall", "major")` from your
in-game report screen.

```gdscript
extends Node

const REPORT_URL := "https://venomboard.com/api/report"
const REPORT_KEY := "vbr_your_key_here"

func send_report(title: String, description := "", severity := "major", reporter := "") -> void:
	await RenderingServer.frame_post_draw  # the frame as the player saw it
	var shot := get_viewport().get_texture().get_image()
	var report := {
		"title": title,
		"description": description,
		"severity": severity,
		"version": str(ProjectSettings.get_setting("application/config/version", "")),
		"platform": OS.get_name(),
		"reporter": reporter,
		"log": _log_tail(60000),
		"screenshot": Marshalls.raw_to_base64(shot.save_jpg_to_buffer(0.85)),
	}
	var http := HTTPRequest.new()
	add_child(http)
	http.request_completed.connect(func(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
		if code != 200:
			push_warning("Bug report not sent (%d): %s" % [code, body.get_string_from_utf8()])
		http.queue_free()
	)
	var headers := PackedStringArray(["Content-Type: application/json", "Authorization: Bearer " + REPORT_KEY])
	var err := http.request(REPORT_URL, headers, HTTPClient.METHOD_POST, JSON.stringify(report))
	if err != OK:
		push_warning("Bug report not sent: %s" % error_string(err))
		http.queue_free()

# the end of the game's log file (file logging is on by default on desktop)
func _log_tail(max_chars: int) -> String:
	var path := str(ProjectSettings.get_setting("debug/file_logging/log_path", "user://logs/godot.log"))
	if not FileAccess.file_exists(path):
		return ""
	var text := FileAccess.get_file_as_string(path)
	return text.substr(maxi(0, text.length() - max_chars))
```

## Unity (C#)

For Unity 2020.2 or later. Save this as `BugReporter.cs`, add it to a GameObject in your first scene, paste your key
into its **Report Key** field in the Inspector, and call
`FindObjectOfType<BugReporter>().Send("Fell through the floor", "Near the waterfall", "major")`.

```csharp
using System;
using System.Collections;
using System.IO;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;

public class BugReporter : MonoBehaviour
{
    const string ReportUrl = "https://venomboard.com/api/report";
    [SerializeField] string reportKey = "vbr_your_key_here";

    [Serializable]
    class Report
    {
        public string title, description, severity, version, platform, reporter, log, screenshot;
    }

    void Awake() => DontDestroyOnLoad(gameObject);

    public void Send(string title, string description = "", string severity = "major", string reporter = "")
    {
        StartCoroutine(SendReport(title, description, severity, reporter));
    }

    IEnumerator SendReport(string title, string description, string severity, string reporter)
    {
        yield return new WaitForEndOfFrame(); // the frame as the player saw it
        var shot = ScreenCapture.CaptureScreenshotAsTexture();
        var jpg = shot.EncodeToJPG(85);
        Destroy(shot);

        var report = new Report
        {
            title = title,
            description = description,
            severity = severity,
            version = Application.version,
            platform = $"{Application.platform}, {SystemInfo.operatingSystem}",
            reporter = reporter,
            log = LogTail(60000),
            screenshot = Convert.ToBase64String(jpg),
        };
        using (var request = new UnityWebRequest(ReportUrl, "POST"))
        {
            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(JsonUtility.ToJson(report)));
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", "Bearer " + reportKey);
            yield return request.SendWebRequest();
            if (request.result != UnityWebRequest.Result.Success)
                Debug.LogWarning($"Bug report not sent ({request.responseCode}): {request.downloadHandler.text}");
        }
    }

    // the end of Player.log (Editor.log in the editor)
    static string LogTail(int maxBytes)
    {
        var path = Application.consoleLogPath;
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return "";
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        {
            if (stream.Length > maxBytes) stream.Seek(-maxBytes, SeekOrigin.End);
            using (var reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
        }
    }
}
```

## Unreal Engine 5 (C++)

Uses the HTTP module. Add the modules to your game's `.Build.cs`:

```csharp
PublicDependencyModuleNames.AddRange(new string[] { "HTTP", "Json", "EngineSettings" });
```

Then add this function library (rename `YOURGAME_API` to your module's API macro). It takes a screenshot of the next
frame, then sends it with the end of the log. Call `UBugReporter::SendBugReport(...)` from C++, or **Send Bug Report**
from Blueprints.

`BugReporter.h`:

```cpp
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "BugReporter.generated.h"

UCLASS()
class YOURGAME_API UBugReporter : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()

public:
	/** Sends a bug report to Venom Board with a screenshot and the end of the log. Severity: crash, major, minor or polish. */
	UFUNCTION(BlueprintCallable, Category = "Bug reports")
	static void SendBugReport(const FString& Title, const FString& Description, const FString& Severity = TEXT("major"), const FString& Reporter = TEXT(""));
};
```

`BugReporter.cpp`:

```cpp
#include "BugReporter.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "Misc/App.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "HAL/PlatformMisc.h"
#include "Engine/GameViewportClient.h"
#include "UnrealClient.h"
#include "ImageUtils.h"
#include "GeneralProjectSettings.h"
#include "Kismet/GameplayStatics.h"

static const TCHAR* ReportUrl = TEXT("https://venomboard.com/api/report");
static const TCHAR* ReportKey = TEXT("vbr_your_key_here");

// the end of the game's log file
static FString LogTail(int32 MaxChars)
{
	FString Log;
	const FString Path = FPaths::ProjectLogDir() / FString(FApp::GetProjectName()) + TEXT(".log");
	FFileHelper::LoadFileToString(Log, *Path, FFileHelper::EHashOptions::None, FILEREAD_AllowWrite);
	return Log.Right(MaxChars);
}

static void PostReport(const FString& Title, const FString& Description, const FString& Severity, const FString& Reporter, const FString& Screenshot)
{
	TSharedRef<FJsonObject> Json = MakeShared<FJsonObject>();
	Json->SetStringField(TEXT("title"), Title);
	Json->SetStringField(TEXT("description"), Description);
	Json->SetStringField(TEXT("severity"), Severity);
	Json->SetStringField(TEXT("version"), GetDefault<UGeneralProjectSettings>()->ProjectVersion);
	Json->SetStringField(TEXT("platform"), UGameplayStatics::GetPlatformName() + TEXT(", ") + FPlatformMisc::GetOSVersion());
	Json->SetStringField(TEXT("reporter"), Reporter);
	Json->SetStringField(TEXT("log"), LogTail(60000));
	if (!Screenshot.IsEmpty())
	{
		Json->SetStringField(TEXT("screenshot"), Screenshot);
	}
	FString Body;
	TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
	FJsonSerializer::Serialize(Json, Writer);

	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(ReportUrl);
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetHeader(TEXT("Authorization"), FString(TEXT("Bearer ")) + ReportKey);
	Request->SetContentAsString(Body);
	Request->OnProcessRequestComplete().BindLambda([](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		if (!bConnected || !Response.IsValid() || Response->GetResponseCode() != 200)
		{
			UE_LOG(LogTemp, Warning, TEXT("Bug report not sent: %s"), Response.IsValid() ? *Response->GetContentAsString() : TEXT("no connection"));
		}
	});
	Request->ProcessRequest();
}

void UBugReporter::SendBugReport(const FString& Title, const FString& Description, const FString& Severity, const FString& Reporter)
{
	TSharedRef<FDelegateHandle> Handle = MakeShared<FDelegateHandle>();
	*Handle = UGameViewportClient::OnScreenshotCaptured().AddLambda([Handle, Title, Description, Severity, Reporter](int32 Width, int32 Height, const TArray<FColor>& Colors)
	{
		UGameViewportClient::OnScreenshotCaptured().Remove(*Handle);
		TArray<FColor> Opaque = Colors;
		for (FColor& Pixel : Opaque)
		{
			Pixel.A = 255;
		}
		TArray64<uint8> Png;
		FImageUtils::PNGCompressImageArray(Width, Height, Opaque, Png);
		// a screenshot over 5 MB (a very large window) is left out; the report still goes
		const FString Screenshot = Png.Num() <= 5 * 1024 * 1024 ? FBase64::Encode(Png.GetData(), Png.Num()) : FString();
		PostReport(Title, Description, Severity, Reporter, Screenshot);
	});
	FScreenshotRequest::RequestScreenshot(false);
}
```
