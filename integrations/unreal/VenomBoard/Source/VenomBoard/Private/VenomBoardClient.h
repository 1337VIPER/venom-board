#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Templates/Function.h"

/** One unfinished card from the my_tasks tool. */
struct FVenomTask
{
	FString ProjectId;
	FString Project;
	FString Team;
	bool bCanEdit = false;
	FString CardId;
	FString Title;
	FString Kind = TEXT("task");
	FString Status = TEXT("todo");
	FString Priority;
	FString Discipline;
	FString Estimate;
	FString Due;
	bool bHasDueInDays = false;
	int32 DueInDays = 0;
	bool bOverdue = false;
	FString Severity;
	FString Phase;
	FString Color;
	bool bAssignedToYou = true;
	TArray<FString> Assignees;
	FString Link;

	FString Key() const { return ProjectId + TEXT("/") + CardId; }
};

/** A project you can open, with how many of your tasks it holds. */
struct FVenomProject
{
	FString ProjectId;
	FString Project;
	FString Team;
	bool bCanEdit = false;
	int32 Tasks = 0;
};

enum class EVenomStatusFilter : uint8
{
	Any,
	ToDo,
	Doing,
	Blocked,
	Overdue,
};

/** What a tool call came back with: the tool's structuredContent, or a message to show. */
struct FVenomAnswer
{
	TSharedPtr<FJsonObject> Result;
	FString Error;

	bool IsOk() const { return Error.IsEmpty() && Result.IsValid(); }
	static FVenomAnswer Fail(const FString& Message);
};

/**
 * Talks to a Venom Board server: JSON-RPC 2.0 "tools/call" requests POSTed to <server>/mcp with a personal
 * access token (Authorization: Bearer vbt_...). The server address and token are kept in the per-user
 * editor settings (EditorSettings.ini on this computer), never in the project.
 */
class FVenomBoardClient
{
public:
	static const TCHAR* const DefaultServer;
	static const TCHAR* const ProtocolVersion;

	FString ServerUrl;
	FString Token;

	FVenomBoardClient();

	void Load();
	void Save() const;

	/** Calls one tool. Done runs once, on the game thread, with the result or a message to show. */
	void CallTool(const FString& Tool, const TSharedRef<FJsonObject>& Arguments, TFunction<void(const FVenomAnswer&)> Done);

	static FString NormaliseServer(const FString& Raw);
	static bool LooksLikeToken(const FString& Value);
	static FString AccountPage(const FString& Server);
	/** Today's date on this computer, YYYY-MM-DD, for due_in_days and overdue. */
	static FString Today();

	static FString ToolCallBody(int32 Id, const FString& Tool, const TSharedRef<FJsonObject>& Arguments);
	static TSharedRef<FJsonObject> MyTasksArguments(const FString& InToday, const FString& ProjectId, bool bIncludeUnassigned);
	static TSharedRef<FJsonObject> SetStatusArguments(const FVenomTask& Task, const FString& Status, const FString& InToday);

	/** Reads an HTTP answer from /mcp. */
	static FVenomAnswer ReadAnswer(int32 HttpStatus, const FString& Body, const FString& Server);
	static void ReadTasks(const FJsonObject& Content, TArray<TSharedPtr<FVenomTask>>& OutTasks, TArray<FVenomProject>& OutProjects, FString& OutNote);
	static TSharedPtr<FVenomTask> ReadTask(const FJsonObject& Row);

	static FString DueText(const FVenomTask& Task);
	static bool Matches(const FVenomTask& Task, const FString& Query, EVenomStatusFilter Filter);
	static FString Describe(const FVenomTask& Task);
	static FString StatusChanged(const FVenomTask& Task);
	static FString StatusName(const FString& Status);
	static FString DisciplineName(const FString& Discipline);
	static FString PriorityName(const FString& Priority);
	static FString KindName(const FString& Kind);

private:
	int32 NextId = 1;
};
