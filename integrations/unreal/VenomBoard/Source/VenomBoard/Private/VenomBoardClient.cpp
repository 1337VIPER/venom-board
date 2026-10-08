#include "VenomBoardClient.h"

#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/DateTime.h"
#include "Policies/CondensedJsonPrintPolicy.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

const TCHAR* const FVenomBoardClient::DefaultServer = TEXT("https://venomboard.com");
const TCHAR* const FVenomBoardClient::ProtocolVersion = TEXT("2025-06-18");

namespace VenomBoard
{
	static const TCHAR* const ConfigSection = TEXT("VenomBoard");
	static const float TimeoutSeconds = 20.f;

	static FString NetworkMessage(EHttpFailureReason Reason, const FString& Server)
	{
		switch (Reason)
		{
		case EHttpFailureReason::TimedOut:
			return TEXT("The server took too long to answer. Try again.");
		case EHttpFailureReason::Cancelled:
			return TEXT("The request was cancelled.");
		case EHttpFailureReason::ConnectionError:
			return FString::Printf(TEXT("Couldn't connect to %s. Check your connection and the server address."), *Server);
		default:
			return FString::Printf(TEXT("The request to %s failed. Check your connection and the server address."), *Server);
		}
	}

	static FString ContentText(const FJsonObject& Result)
	{
		const TArray<TSharedPtr<FJsonValue>>* Parts = nullptr;
		if (Result.TryGetArrayField(TEXT("content"), Parts) && Parts)
		{
			for (const TSharedPtr<FJsonValue>& Part : *Parts)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				FString Type, Text;
				if (Part.IsValid() && Part->TryGetObject(Object) && Object && Object->IsValid()
					&& (*Object)->TryGetStringField(TEXT("type"), Type) && Type == TEXT("text") && (*Object)->TryGetStringField(TEXT("text"), Text))
				{
					return Text;
				}
			}
		}
		return TEXT("The server couldn't do that.");
	}

	static FString Lookup(const TMap<FString, FString>& Names, const FString& Key)
	{
		const FString* Found = Names.Find(Key);
		return Found ? *Found : Key;
	}
}

FVenomAnswer FVenomAnswer::Fail(const FString& Message)
{
	FVenomAnswer Answer;
	Answer.Error = Message;
	return Answer;
}

FVenomBoardClient::FVenomBoardClient()
	: ServerUrl(DefaultServer)
{
}

void FVenomBoardClient::Load()
{
	FString Server, SavedToken;
	GConfig->GetString(VenomBoard::ConfigSection, TEXT("ServerUrl"), Server, GEditorSettingsIni);
	GConfig->GetString(VenomBoard::ConfigSection, TEXT("AccessToken"), SavedToken, GEditorSettingsIni);
	ServerUrl = NormaliseServer(Server);
	Token = SavedToken.TrimStartAndEnd();
}

void FVenomBoardClient::Save() const
{
	GConfig->SetString(VenomBoard::ConfigSection, TEXT("ServerUrl"), *ServerUrl, GEditorSettingsIni);
	GConfig->SetString(VenomBoard::ConfigSection, TEXT("AccessToken"), *Token, GEditorSettingsIni);
	GConfig->Flush(false, GEditorSettingsIni);
}

void FVenomBoardClient::CallTool(const FString& Tool, const TSharedRef<FJsonObject>& Arguments, TFunction<void(const FVenomAnswer&)> Done)
{
	if (Token.IsEmpty())
	{
		Done(FVenomAnswer::Fail(TEXT("Add your access token in Settings to see your tasks.")));
		return;
	}
	const FString Server = ServerUrl;
	// whichever comes first, the answer or a failure to send, is the one reported
	TSharedRef<bool> bAnswered = MakeShared<bool>(false);
	TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Server + TEXT("/mcp"));
	Request->SetVerb(TEXT("POST"));
	Request->SetHeader(TEXT("Content-Type"), TEXT("application/json"));
	Request->SetHeader(TEXT("Accept"), TEXT("application/json, text/event-stream"));
	Request->SetHeader(TEXT("MCP-Protocol-Version"), ProtocolVersion);
	Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Token);
	Request->SetTimeout(VenomBoard::TimeoutSeconds);
	Request->SetContentAsString(ToolCallBody(NextId++, Tool, Arguments));
	Request->OnProcessRequestComplete().BindLambda([Server, Done, bAnswered](FHttpRequestPtr Req, FHttpResponsePtr Res, bool bProcessed)
	{
		if (*bAnswered)
		{
			return;
		}
		*bAnswered = true;
		if (!bProcessed || !Res.IsValid())
		{
			Done(FVenomAnswer::Fail(VenomBoard::NetworkMessage(Req.IsValid() ? Req->GetFailureReason() : EHttpFailureReason::Other, Server)));
			return;
		}
		Done(ReadAnswer(Res->GetResponseCode(), Res->GetContentAsString(), Server));
	});
	if (!Request->ProcessRequest() && !*bAnswered)
	{
		*bAnswered = true;
		Done(FVenomAnswer::Fail(TEXT("Couldn't send the request. Check the server address in Settings.")));
	}
}

FString FVenomBoardClient::NormaliseServer(const FString& Raw)
{
	FString Server = Raw.TrimStartAndEnd();
	if (Server.IsEmpty())
	{
		return DefaultServer;
	}
	if (!Server.StartsWith(TEXT("http://"), ESearchCase::IgnoreCase) && !Server.StartsWith(TEXT("https://"), ESearchCase::IgnoreCase))
	{
		Server = TEXT("https://") + Server;
	}
	while (Server.EndsWith(TEXT("/")))
	{
		Server = Server.LeftChop(1);
	}
	return Server;
}

bool FVenomBoardClient::LooksLikeToken(const FString& Value)
{
	const FString Trimmed = Value.TrimStartAndEnd();
	if (!Trimmed.StartsWith(TEXT("vbt_"), ESearchCase::CaseSensitive) || Trimmed.Len() < 24 || Trimmed.Len() > 84)
	{
		return false;
	}
	for (int32 i = 4; i < Trimmed.Len(); ++i)
	{
		const TCHAR C = Trimmed[i];
		if (!FChar::IsAlnum(C) && C != TEXT('_') && C != TEXT('-'))
		{
			return false;
		}
	}
	return true;
}

FString FVenomBoardClient::AccountPage(const FString& Server)
{
	return NormaliseServer(Server) + TEXT("/account#mcp");
}

FString FVenomBoardClient::Today()
{
	return FDateTime::Now().ToString(TEXT("%Y-%m-%d"));
}

FString FVenomBoardClient::ToolCallBody(int32 Id, const FString& Tool, const TSharedRef<FJsonObject>& Arguments)
{
	TSharedRef<FJsonObject> Params = MakeShared<FJsonObject>();
	Params->SetStringField(TEXT("name"), Tool);
	Params->SetObjectField(TEXT("arguments"), Arguments);
	TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("jsonrpc"), TEXT("2.0"));
	Message->SetNumberField(TEXT("id"), Id);
	Message->SetStringField(TEXT("method"), TEXT("tools/call"));
	Message->SetObjectField(TEXT("params"), Params);
	FString Out;
	TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer = TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
	FJsonSerializer::Serialize(Message, Writer);
	return Out;
}

TSharedRef<FJsonObject> FVenomBoardClient::MyTasksArguments(const FString& InToday, const FString& ProjectId, bool bIncludeUnassigned)
{
	TSharedRef<FJsonObject> Args = MakeShared<FJsonObject>();
	Args->SetStringField(TEXT("today"), InToday);
	if (!ProjectId.IsEmpty())
	{
		Args->SetStringField(TEXT("project_id"), ProjectId);
		if (bIncludeUnassigned)
		{
			Args->SetBoolField(TEXT("include_unassigned_in_project"), true);
		}
	}
	return Args;
}

TSharedRef<FJsonObject> FVenomBoardClient::SetStatusArguments(const FVenomTask& Task, const FString& Status, const FString& InToday)
{
	TSharedRef<FJsonObject> Args = MakeShared<FJsonObject>();
	Args->SetStringField(TEXT("project_id"), Task.ProjectId);
	Args->SetStringField(TEXT("card_id"), Task.CardId);
	Args->SetStringField(TEXT("status"), Status);
	Args->SetStringField(TEXT("today"), InToday);
	return Args;
}

FVenomAnswer FVenomBoardClient::ReadAnswer(int32 HttpStatus, const FString& Body, const FString& Server)
{
	const FString Where = NormaliseServer(Server);
	if (HttpStatus == 401)
	{
		return FVenomAnswer::Fail(TEXT("Check your token: the server didn't accept it. It may be mistyped, revoked, or made on another server. Make a new one on your account page under Connect tools (MCP)."));
	}
	if (HttpStatus == 429)
	{
		return FVenomAnswer::Fail(TEXT("Too many requests. Wait a minute, then refresh."));
	}
	if (HttpStatus == 403)
	{
		return FVenomAnswer::Fail(TEXT("The server refused the request (403)."));
	}
	if (HttpStatus >= 500)
	{
		return FVenomAnswer::Fail(FString::Printf(TEXT("The server had a problem (HTTP %d). Try again in a moment."), HttpStatus));
	}
	TSharedPtr<FJsonObject> Root;
	if (HttpStatus != 200 || !FJsonSerializer::Deserialize(TJsonReaderFactory<TCHAR>::Create(Body), Root) || !Root.IsValid())
	{
		return FVenomAnswer::Fail(FString::Printf(TEXT("Unexpected answer from %s (HTTP %d). Check the server address in Settings."), *Where, HttpStatus));
	}
	const TSharedPtr<FJsonObject>* Error = nullptr;
	if (Root->TryGetObjectField(TEXT("error"), Error) && Error && Error->IsValid())
	{
		double Code = 0;
		(*Error)->TryGetNumberField(TEXT("code"), Code);
		if (FMath::RoundToInt32(Code) == -32602)
		{
			return FVenomAnswer::Fail(TEXT("This server doesn't have the tools the panel needs yet. Check the server address, or update the server."));
		}
		FString Message;
		(*Error)->TryGetStringField(TEXT("message"), Message);
		return FVenomAnswer::Fail(Message.IsEmpty() ? FString(TEXT("The server answered with an error.")) : Message);
	}
	const TSharedPtr<FJsonObject>* Result = nullptr;
	if (!Root->TryGetObjectField(TEXT("result"), Result) || !Result || !Result->IsValid())
	{
		return FVenomAnswer::Fail(TEXT("Unexpected answer from the server."));
	}
	bool bIsError = false;
	if ((*Result)->TryGetBoolField(TEXT("isError"), bIsError) && bIsError)
	{
		return FVenomAnswer::Fail(VenomBoard::ContentText(**Result));
	}
	const TSharedPtr<FJsonObject>* Content = nullptr;
	if (!(*Result)->TryGetObjectField(TEXT("structuredContent"), Content) || !Content || !Content->IsValid())
	{
		return FVenomAnswer::Fail(TEXT("Unexpected answer from the server."));
	}
	FVenomAnswer Answer;
	Answer.Result = *Content;
	return Answer;
}

void FVenomBoardClient::ReadTasks(const FJsonObject& Content, TArray<TSharedPtr<FVenomTask>>& OutTasks, TArray<FVenomProject>& OutProjects, FString& OutNote)
{
	OutTasks.Reset();
	OutProjects.Reset();
	OutNote.Reset();
	Content.TryGetStringField(TEXT("note"), OutNote);
	const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
	if (Content.TryGetArrayField(TEXT("tasks"), Rows) && Rows)
	{
		for (const TSharedPtr<FJsonValue>& Value : *Rows)
		{
			const TSharedPtr<FJsonObject>* Row = nullptr;
			if (Value.IsValid() && Value->TryGetObject(Row) && Row && Row->IsValid())
			{
				OutTasks.Add(ReadTask(**Row));
			}
		}
	}
	const TArray<TSharedPtr<FJsonValue>>* ProjectRows = nullptr;
	if (Content.TryGetArrayField(TEXT("projects"), ProjectRows) && ProjectRows)
	{
		for (const TSharedPtr<FJsonValue>& Value : *ProjectRows)
		{
			const TSharedPtr<FJsonObject>* Row = nullptr;
			if (Value.IsValid() && Value->TryGetObject(Row) && Row && Row->IsValid())
			{
				FVenomProject Project;
				(*Row)->TryGetStringField(TEXT("project_id"), Project.ProjectId);
				(*Row)->TryGetStringField(TEXT("project"), Project.Project);
				(*Row)->TryGetStringField(TEXT("team"), Project.Team);
				(*Row)->TryGetBoolField(TEXT("can_edit"), Project.bCanEdit);
				(*Row)->TryGetNumberField(TEXT("tasks"), Project.Tasks);
				OutProjects.Add(Project);
			}
		}
	}
}

TSharedPtr<FVenomTask> FVenomBoardClient::ReadTask(const FJsonObject& Row)
{
	TSharedPtr<FVenomTask> Task = MakeShared<FVenomTask>();
	Row.TryGetStringField(TEXT("project_id"), Task->ProjectId);
	Row.TryGetStringField(TEXT("project"), Task->Project);
	Row.TryGetStringField(TEXT("team"), Task->Team);
	Row.TryGetBoolField(TEXT("can_edit"), Task->bCanEdit);
	Row.TryGetStringField(TEXT("card_id"), Task->CardId);
	Row.TryGetStringField(TEXT("title"), Task->Title);
	Row.TryGetStringField(TEXT("kind"), Task->Kind);
	Row.TryGetStringField(TEXT("status"), Task->Status);
	Row.TryGetStringField(TEXT("priority"), Task->Priority);
	Row.TryGetStringField(TEXT("discipline"), Task->Discipline);
	Row.TryGetStringField(TEXT("estimate"), Task->Estimate);
	Row.TryGetStringField(TEXT("due"), Task->Due);
	Row.TryGetBoolField(TEXT("overdue"), Task->bOverdue);
	Row.TryGetStringField(TEXT("severity"), Task->Severity);
	Row.TryGetStringField(TEXT("phase"), Task->Phase);
	Row.TryGetStringField(TEXT("color"), Task->Color);
	Row.TryGetBoolField(TEXT("assigned_to_you"), Task->bAssignedToYou);
	Row.TryGetStringField(TEXT("link"), Task->Link);
	double Days = 0;
	if (Row.HasTypedField(TEXT("due_in_days"), EJson::Number) && Row.TryGetNumberField(TEXT("due_in_days"), Days))
	{
		Task->bHasDueInDays = true;
		Task->DueInDays = FMath::RoundToInt32(Days);
	}
	const TArray<TSharedPtr<FJsonValue>>* People = nullptr;
	if (Row.TryGetArrayField(TEXT("assignees"), People) && People)
	{
		for (const TSharedPtr<FJsonValue>& Person : *People)
		{
			FString Name;
			if (Person.IsValid() && Person->TryGetString(Name))
			{
				Task->Assignees.Add(Name);
			}
		}
	}
	return Task;
}

FString FVenomBoardClient::DueText(const FVenomTask& Task)
{
	if (Task.Due.IsEmpty() || !Task.bHasDueInDays)
	{
		return FString();
	}
	const int32 Days = Task.DueInDays;
	if (Days < -1)
	{
		return FString::Printf(TEXT("%d days late"), -Days);
	}
	if (Days == -1)
	{
		return TEXT("1 day late");
	}
	if (Days == 0)
	{
		return TEXT("Today");
	}
	if (Days == 1)
	{
		return TEXT("Tomorrow");
	}
	if (Days < 7)
	{
		return FString::Printf(TEXT("In %d days"), Days);
	}
	return Task.Due;
}

bool FVenomBoardClient::Matches(const FVenomTask& Task, const FString& Query, EVenomStatusFilter Filter)
{
	switch (Filter)
	{
	case EVenomStatusFilter::ToDo:
		if (Task.Status != TEXT("todo")) { return false; }
		break;
	case EVenomStatusFilter::Doing:
		if (Task.Status != TEXT("doing")) { return false; }
		break;
	case EVenomStatusFilter::Blocked:
		if (Task.Status != TEXT("blocked")) { return false; }
		break;
	case EVenomStatusFilter::Overdue:
		if (!Task.bOverdue) { return false; }
		break;
	default:
		break;
	}
	TArray<FString> Words;
	Query.TrimStartAndEnd().ParseIntoArray(Words, TEXT(" "), true);
	if (Words.Num() == 0)
	{
		return true;
	}
	const FString Haystack = FString::Join(TArray<FString>{ Task.Title, Task.Project, Task.Team, Task.Phase,
		DisciplineName(Task.Discipline), KindName(Task.Kind), PriorityName(Task.Priority) }, TEXT(" "));
	for (const FString& Word : Words)
	{
		if (!Haystack.Contains(Word, ESearchCase::IgnoreCase))
		{
			return false;
		}
	}
	return true;
}

FString FVenomBoardClient::Describe(const FVenomTask& Task)
{
	TArray<FString> Facts = { KindName(Task.Kind) };
	if (!Task.Discipline.IsEmpty()) { Facts.Add(DisciplineName(Task.Discipline)); }
	if (!Task.Priority.IsEmpty()) { Facts.Add(PriorityName(Task.Priority)); }
	if (!Task.Severity.IsEmpty()) { Facts.Add(TEXT("Severity: ") + Task.Severity); }
	if (!Task.Estimate.IsEmpty()) { Facts.Add(TEXT("Estimate ") + Task.Estimate); }
	TArray<FString> Lines = { Task.Title, FString::Join(Facts, TEXT(", ")) };
	if (!Task.Due.IsEmpty()) { Lines.Add(TEXT("Due ") + Task.Due + (Task.bOverdue ? TEXT(" (overdue)") : TEXT(""))); }
	if (!Task.Phase.IsEmpty()) { Lines.Add(TEXT("Phase: ") + Task.Phase); }
	if (Task.Assignees.Num() > 0) { Lines.Add(TEXT("Assigned: ") + FString::Join(Task.Assignees, TEXT(", "))); }
	else if (!Task.bAssignedToYou) { Lines.Add(TEXT("Nobody has taken this yet.")); }
	if (!Task.bCanEdit) { Lines.Add(TEXT("You can only view this project.")); }
	Lines.Add(TEXT("Double-click to open it in the browser."));
	return FString::Join(Lines, TEXT("\n"));
}

FString FVenomBoardClient::StatusChanged(const FVenomTask& Task)
{
	if (Task.Status == TEXT("doing")) { return FString::Printf(TEXT("Started \"%s\"."), *Task.Title); }
	if (Task.Status == TEXT("done")) { return FString::Printf(TEXT("\"%s\" is done."), *Task.Title); }
	if (Task.Status == TEXT("blocked")) { return FString::Printf(TEXT("\"%s\" is blocked."), *Task.Title); }
	if (Task.Status == TEXT("todo")) { return FString::Printf(TEXT("\"%s\" is back to do."), *Task.Title); }
	return FString::Printf(TEXT("Updated \"%s\"."), *Task.Title);
}

FString FVenomBoardClient::StatusName(const FString& Status)
{
	static const TMap<FString, FString> Names = {
		{ TEXT("todo"), TEXT("To do") }, { TEXT("doing"), TEXT("Doing") }, { TEXT("blocked"), TEXT("Blocked") }, { TEXT("done"), TEXT("Done") },
	};
	return VenomBoard::Lookup(Names, Status);
}

FString FVenomBoardClient::DisciplineName(const FString& Discipline)
{
	static const TMap<FString, FString> Names = {
		{ TEXT("code"), TEXT("Code") }, { TEXT("art"), TEXT("Art") }, { TEXT("design"), TEXT("Design") }, { TEXT("level"), TEXT("Level design") },
		{ TEXT("audio"), TEXT("Audio") }, { TEXT("ui"), TEXT("UI/UX") }, { TEXT("vfx"), TEXT("VFX") }, { TEXT("narr"), TEXT("Narrative") },
		{ TEXT("qa"), TEXT("QA") }, { TEXT("tech"), TEXT("Tech/build") }, { TEXT("mkt"), TEXT("Marketing") },
	};
	return VenomBoard::Lookup(Names, Discipline);
}

FString FVenomBoardClient::PriorityName(const FString& Priority)
{
	static const TMap<FString, FString> Names = {
		{ TEXT("must"), TEXT("Must") }, { TEXT("should"), TEXT("Should") }, { TEXT("could"), TEXT("Could") }, { TEXT("wont"), TEXT("Won't") },
	};
	return VenomBoard::Lookup(Names, Priority);
}

FString FVenomBoardClient::KindName(const FString& Kind)
{
	static const TMap<FString, FString> Names = {
		{ TEXT("task"), TEXT("Task") }, { TEXT("bug"), TEXT("Bug") }, { TEXT("milestone"), TEXT("Milestone") }, { TEXT("idea"), TEXT("Idea") },
	};
	return VenomBoard::Lookup(Names, Kind);
}
