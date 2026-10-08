// Automation tests (Session Frontend > Automation, or -ExecCmds="Automation RunTests VenomBoard").
// VenomBoard.Protocol reads answers offline. VenomBoard.Live talks to a real server when the environment variables
// VENOM_BOARD_TEST_SERVER and VENOM_BOARD_TEST_TOKEN are set (use a test account), and is skipped otherwise.
#include "Misc/AutomationTest.h"
#include "VenomBoardClient.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformMisc.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#if WITH_DEV_AUTOMATION_TESTS

namespace VenomBoardTests
{
	static const TCHAR* const MyTasksAnswer = TEXT(R"json({"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"..."}],"structuredContent":{
		"today":"2026-01-15","you":"vee","total":3,
		"tasks":[
			{"project_id":"p1","project":"Slice","team":"Night Keep","can_edit":true,"card_id":"late","title":"Boss arena blockout","kind":"task","status":"todo","priority":"should","discipline":"level","estimate":"2d","due":"2026-01-10","due_in_days":-5,"overdue":true,"severity":"","phase":"01 - Prototype","color":"#3dff8b","assigned_to_you":true,"assignees":["Vee"],"link":"https://venomboard.com/app#p=p1&c=late"},
			{"project_id":"p2","project":"Quest log","team":"Side Quest","can_edit":false,"card_id":"q1","title":"Quest journal UI","kind":"task","status":"doing","priority":"","discipline":"ui","estimate":"","due":"2026-01-16","due_in_days":1,"overdue":false,"severity":"","phase":"","color":"#ff7a1a","assigned_to_you":true,"assignees":["Vee","Nyx"],"link":"https://venomboard.com/app#p=p2&c=q1"},
			{"project_id":"p1","project":"Slice","team":"Night Keep","can_edit":true,"card_id":"free","title":"Write the intro","kind":"bug","status":"blocked","priority":"must","discipline":"","estimate":"","due":"","due_in_days":null,"overdue":false,"severity":"crash","phase":"","color":"#f1eef2","assigned_to_you":false,"assignees":[],"link":"https://venomboard.com/app#p=p1&c=free"}
		],
		"projects":[{"project_id":"p1","project":"Slice","team":"Night Keep","can_edit":true,"tasks":2},{"project_id":"p2","project":"Quest log","team":"Side Quest","can_edit":false,"tasks":1}]
	}}})json");
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVenomBoardProtocolTest, "VenomBoard.Protocol", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FVenomBoardProtocolTest::RunTest(const FString& Parameters)
{
	// settings and requests
	TestEqual(TEXT("server address tidied"), FVenomBoardClient::NormaliseServer(TEXT(" venomboard.com/ ")), FString(TEXT("https://venomboard.com")));
	TestEqual(TEXT("local server kept"), FVenomBoardClient::NormaliseServer(TEXT("http://localhost:8816//")), FString(TEXT("http://localhost:8816")));
	TestEqual(TEXT("empty means the default"), FVenomBoardClient::NormaliseServer(TEXT("")), FString(FVenomBoardClient::DefaultServer));
	TestTrue(TEXT("a token"), FVenomBoardClient::LooksLikeToken(TEXT("vbt_abcdefghijklmnopqrstuvwxyz0123456789-_ABCDEFG")));
	TestFalse(TEXT("not a token"), FVenomBoardClient::LooksLikeToken(TEXT("abc")));
	TestFalse(TEXT("too short"), FVenomBoardClient::LooksLikeToken(TEXT("vbt_short")));
	TestFalse(TEXT("bad characters"), FVenomBoardClient::LooksLikeToken(TEXT("vbt_abcdefghijklmnopqrst uvwxyz")));

	const FString Body = FVenomBoardClient::ToolCallBody(7, TEXT("my_tasks"), FVenomBoardClient::MyTasksArguments(TEXT("2026-01-15"), TEXT("p1"), true));
	TSharedPtr<FJsonObject> Sent;
	TestTrue(TEXT("request is JSON"), FJsonSerializer::Deserialize(TJsonReaderFactory<TCHAR>::Create(Body), Sent) && Sent.IsValid());
	if (Sent.IsValid())
	{
		TestEqual(TEXT("jsonrpc"), Sent->GetStringField(TEXT("jsonrpc")), FString(TEXT("2.0")));
		TestEqual(TEXT("method"), Sent->GetStringField(TEXT("method")), FString(TEXT("tools/call")));
		TestEqual(TEXT("id"), FMath::RoundToInt32(Sent->GetNumberField(TEXT("id"))), 7);
		const TSharedPtr<FJsonObject> Params = Sent->GetObjectField(TEXT("params"));
		TestEqual(TEXT("tool name"), Params->GetStringField(TEXT("name")), FString(TEXT("my_tasks")));
		const TSharedPtr<FJsonObject> Args = Params->GetObjectField(TEXT("arguments"));
		TestEqual(TEXT("project"), Args->GetStringField(TEXT("project_id")), FString(TEXT("p1")));
		TestTrue(TEXT("unassigned"), Args->GetBoolField(TEXT("include_unassigned_in_project")));
		TestEqual(TEXT("today"), Args->GetStringField(TEXT("today")), FString(TEXT("2026-01-15")));
	}
	TestFalse(TEXT("unassigned only with a project"), FVenomBoardClient::MyTasksArguments(TEXT("2026-01-15"), FString(), true)->HasField(TEXT("include_unassigned_in_project")));

	// reading my_tasks
	const FVenomAnswer Answer = FVenomBoardClient::ReadAnswer(200, VenomBoardTests::MyTasksAnswer, TEXT("https://venomboard.com"));
	TestTrue(TEXT("answer read"), Answer.IsOk());
	if (!Answer.IsOk())
	{
		AddError(Answer.Error);
		return false;
	}
	TArray<TSharedPtr<FVenomTask>> Tasks;
	TArray<FVenomProject> Projects;
	FString Note;
	FVenomBoardClient::ReadTasks(*Answer.Result, Tasks, Projects, Note);
	TestEqual(TEXT("tasks"), Tasks.Num(), 3);
	TestEqual(TEXT("projects"), Projects.Num(), 2);
	if (Tasks.Num() != 3 || Projects.Num() != 2)
	{
		return false;
	}
	const FVenomTask& Late = *Tasks[0];
	TestEqual(TEXT("title"), Late.Title, FString(TEXT("Boss arena blockout")));
	TestEqual(TEXT("project id"), Late.ProjectId, FString(TEXT("p1")));
	TestTrue(TEXT("can edit"), Late.bCanEdit);
	TestTrue(TEXT("overdue"), Late.bOverdue);
	TestTrue(TEXT("has days"), Late.bHasDueInDays);
	TestEqual(TEXT("days"), Late.DueInDays, -5);
	TestEqual(TEXT("late text"), FVenomBoardClient::DueText(Late), FString(TEXT("5 days late")));
	TestEqual(TEXT("link"), Late.Link, FString(TEXT("https://venomboard.com/app#p=p1&c=late")));
	TestEqual(TEXT("colour"), Late.Color, FString(TEXT("#3dff8b")));
	TestEqual(TEXT("tomorrow"), FVenomBoardClient::DueText(*Tasks[1]), FString(TEXT("Tomorrow")));
	TestFalse(TEXT("view only"), Tasks[1]->bCanEdit);
	TestEqual(TEXT("assignees"), Tasks[1]->Assignees.Num(), 2);
	TestFalse(TEXT("no due date"), Tasks[2]->bHasDueInDays);
	TestEqual(TEXT("no due text"), FVenomBoardClient::DueText(*Tasks[2]), FString());
	TestFalse(TEXT("unassigned"), Tasks[2]->bAssignedToYou);
	TestEqual(TEXT("severity"), Tasks[2]->Severity, FString(TEXT("crash")));
	TestEqual(TEXT("project counts"), Projects[0].Tasks + Projects[1].Tasks, 3);
	TestFalse(TEXT("second project view only"), Projects[1].bCanEdit);

	// filters
	int32 LevelDesign = 0, Overdue = 0, Blocked = 0, Words = 0;
	for (const TSharedPtr<FVenomTask>& Task : Tasks)
	{
		LevelDesign += FVenomBoardClient::Matches(*Task, TEXT("level"), EVenomStatusFilter::Any) ? 1 : 0;
		Overdue += FVenomBoardClient::Matches(*Task, FString(), EVenomStatusFilter::Overdue) ? 1 : 0;
		Blocked += FVenomBoardClient::Matches(*Task, FString(), EVenomStatusFilter::Blocked) ? 1 : 0;
		Words += FVenomBoardClient::Matches(*Task, TEXT("SLICE must"), EVenomStatusFilter::Any) ? 1 : 0;
	}
	TestEqual(TEXT("filter by discipline name"), LevelDesign, 1);
	TestEqual(TEXT("overdue filter"), Overdue, 1);
	TestEqual(TEXT("blocked filter"), Blocked, 1);
	TestEqual(TEXT("every word must match, any case"), Words, 1);
	TestTrue(TEXT("tooltip"), FVenomBoardClient::Describe(Late).Contains(TEXT("Level design, Should, Estimate 2d")));
	TestEqual(TEXT("status message"), FVenomBoardClient::StatusChanged(*Tasks[1]), FString(TEXT("Started \"Quest journal UI\".")));

	// what goes wrong
	TestTrue(TEXT("401"), FVenomBoardClient::ReadAnswer(401, TEXT("{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32001,\"message\":\"x\"}}"), TEXT("https://venomboard.com")).Error.StartsWith(TEXT("Check your token")));
	TestTrue(TEXT("429"), FVenomBoardClient::ReadAnswer(429, FString(), TEXT("https://venomboard.com")).Error.StartsWith(TEXT("Too many requests")));
	TestTrue(TEXT("5xx"), FVenomBoardClient::ReadAnswer(502, TEXT("Bad gateway"), TEXT("https://venomboard.com")).Error.Contains(TEXT("HTTP 502")));
	TestTrue(TEXT("not an MCP server"), FVenomBoardClient::ReadAnswer(200, TEXT("<html></html>"), TEXT("example.test")).Error.StartsWith(TEXT("Unexpected answer from https://example.test")));
	TestEqual(TEXT("tool error text"), FVenomBoardClient::ReadAnswer(200, TEXT("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"isError\":true,\"content\":[{\"type\":\"text\",\"text\":\"You're a viewer\"}]}}"), TEXT("x")).Error, FString(TEXT("You're a viewer")));
	TestTrue(TEXT("old server"), FVenomBoardClient::ReadAnswer(200, TEXT("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32602,\"message\":\"Unknown tool\"}}"), TEXT("x")).Error.Contains(TEXT("doesn't have the tools")));
	return true;
}

IMPLEMENT_SIMPLE_AUTOMATION_TEST(FVenomBoardLiveTest, "VenomBoard.Live", EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FVenomBoardLiveTest::RunTest(const FString& Parameters)
{
	const FString Server = FPlatformMisc::GetEnvironmentVariable(TEXT("VENOM_BOARD_TEST_SERVER"));
	const FString Token = FPlatformMisc::GetEnvironmentVariable(TEXT("VENOM_BOARD_TEST_TOKEN"));
	if (Server.IsEmpty() || Token.IsEmpty())
	{
		AddInfo(TEXT("Skipped: set VENOM_BOARD_TEST_SERVER and VENOM_BOARD_TEST_TOKEN to run it against a server."));
		return true;
	}
	struct FState
	{
		FVenomBoardClient Client;
		int32 Step = 0;
		bool bWaiting = false;
		TArray<TSharedPtr<FVenomTask>> Tasks;
	};
	TSharedRef<FState> State = MakeShared<FState>();
	State->Client.ServerUrl = FVenomBoardClient::NormaliseServer(Server);
	State->Client.Token = Token;
	const double Started = FPlatformTime::Seconds();
	ADD_LATENT_AUTOMATION_COMMAND(FFunctionLatentCommand([this, State, Started]() -> bool
	{
		if (FPlatformTime::Seconds() - Started > 60.0)
		{
			AddError(TEXT("The server didn't answer within a minute."));
			return true;
		}
		if (State->bWaiting)
		{
			return false;
		}
		switch (State->Step)
		{
		case 0:
			State->bWaiting = true;
			State->Client.CallTool(TEXT("my_tasks"), FVenomBoardClient::MyTasksArguments(FVenomBoardClient::Today(), FString(), false), [this, State](const FVenomAnswer& Answer)
			{
				State->bWaiting = false;
				State->Step = 1;
				if (!Answer.IsOk())
				{
					AddError(TEXT("my_tasks: ") + Answer.Error);
					State->Step = 99;
					return;
				}
				TArray<FVenomProject> Projects;
				FString Note;
				FVenomBoardClient::ReadTasks(*Answer.Result, State->Tasks, Projects, Note);
				AddInfo(FString::Printf(TEXT("my_tasks: %d tasks in %d projects"), State->Tasks.Num(), Projects.Num()));
				for (const TSharedPtr<FVenomTask>& Task : State->Tasks)
				{
					AddInfo(FString::Printf(TEXT("  %s - %s [%s] %s"), *Task->Project, *Task->Title, *Task->Status, *FVenomBoardClient::DueText(*Task)));
				}
			});
			return false;
		case 1:
		{
			const TSharedPtr<FVenomTask>* Editable = State->Tasks.FindByPredicate([](const TSharedPtr<FVenomTask>& Task) { return Task->bCanEdit && Task->Status == TEXT("todo"); });
			if (!Editable)
			{
				AddInfo(TEXT("No task to start, so set_card_status wasn't tried."));
				return true;
			}
			const TSharedPtr<FVenomTask> Task = *Editable;
			State->bWaiting = true;
			State->Client.CallTool(TEXT("set_card_status"), FVenomBoardClient::SetStatusArguments(*Task, TEXT("doing"), FVenomBoardClient::Today()), [this, State, Task](const FVenomAnswer& Answer)
			{
				State->bWaiting = false;
				State->Step = 2;
				const TSharedPtr<FJsonObject>* Row = nullptr;
				if (!Answer.IsOk() || !Answer.Result->TryGetObjectField(TEXT("task"), Row) || !Row)
				{
					AddError(TEXT("set_card_status: ") + Answer.Error);
					State->Step = 99;
					return;
				}
				const TSharedPtr<FVenomTask> Updated = FVenomBoardClient::ReadTask(**Row);
				TestEqual(TEXT("started"), Updated->Status, FString(TEXT("doing")));
				AddInfo(FVenomBoardClient::StatusChanged(*Updated));
				// put it back as it was
				State->Client.CallTool(TEXT("set_card_status"), FVenomBoardClient::SetStatusArguments(*Task, TEXT("todo"), FVenomBoardClient::Today()), [](const FVenomAnswer&) {});
			});
			return false;
		}
		case 2:
		{
			State->bWaiting = true;
			FVenomBoardClient Wrong;
			Wrong.ServerUrl = State->Client.ServerUrl;
			Wrong.Token = TEXT("vbt_") + FString::ChrN(43, TEXT('x'));
			Wrong.CallTool(TEXT("my_tasks"), FVenomBoardClient::MyTasksArguments(FVenomBoardClient::Today(), FString(), false), [this, State](const FVenomAnswer& Answer)
			{
				State->bWaiting = false;
				State->Step = 99;
				TestTrue(TEXT("a wrong token is reported"), Answer.Error.StartsWith(TEXT("Check your token")));
				AddInfo(TEXT("Wrong token: ") + Answer.Error);
			});
			return false;
		}
		default:
			return true;
		}
	}));
	return true;
}

#endif
