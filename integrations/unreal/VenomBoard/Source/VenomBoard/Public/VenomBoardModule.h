#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleInterface.h"

class SDockTab;
class FSpawnTabArgs;

/** Registers the Venom Board tab (Tools > Venom Board) with the editor. */
class FVenomBoardModule : public IModuleInterface
{
public:
	virtual void StartupModule() override;
	virtual void ShutdownModule() override;

private:
	TSharedRef<SDockTab> SpawnTab(const FSpawnTabArgs& Args);
};
