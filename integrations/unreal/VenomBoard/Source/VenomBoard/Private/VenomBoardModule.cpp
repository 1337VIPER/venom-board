#include "VenomBoardModule.h"

#include "Framework/Application/SlateApplication.h"
#include "Framework/Docking/TabManager.h"
#include "Modules/ModuleManager.h"
#include "SVenomBoardPanel.h"
#include "Styling/AppStyle.h"
#include "Widgets/Docking/SDockTab.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"

#define LOCTEXT_NAMESPACE "VenomBoard"

static const FName VenomBoardTabName(TEXT("VenomBoardTasks"));

void FVenomBoardModule::StartupModule()
{
	FGlobalTabmanager::Get()->RegisterNomadTabSpawner(VenomBoardTabName, FOnSpawnTab::CreateRaw(this, &FVenomBoardModule::SpawnTab))
		.SetDisplayName(LOCTEXT("TabTitle", "Venom Board"))
		.SetTooltipText(LOCTEXT("TabTooltip", "Your Venom Board tasks: the unfinished cards assigned to you across your team projects."))
		.SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory())
		.SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), "Icons.Clipboard"));
}

void FVenomBoardModule::ShutdownModule()
{
	if (FSlateApplication::IsInitialized())
	{
		FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(VenomBoardTabName);
	}
}

TSharedRef<SDockTab> FVenomBoardModule::SpawnTab(const FSpawnTabArgs& Args)
{
	return SNew(SDockTab)
		.TabRole(ETabRole::NomadTab)
		[
			SNew(SVenomBoardPanel)
		];
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FVenomBoardModule, VenomBoard)
