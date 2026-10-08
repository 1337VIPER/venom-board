using UnrealBuildTool;

public class VenomBoard : ModuleRules
{
	public VenomBoard(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"Core",
			"CoreUObject",
			"ApplicationCore",
			"InputCore",
			"Slate",
			"SlateCore",
			"WorkspaceMenuStructure",
			"HTTP",
			"Json",
		});
	}
}
