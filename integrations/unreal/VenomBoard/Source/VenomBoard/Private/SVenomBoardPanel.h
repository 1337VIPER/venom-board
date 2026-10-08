#pragma once

#include "CoreMinimal.h"
#include "VenomBoardClient.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/Views/STreeView.h"

class SEditableTextBox;

/**
 * The Venom Board tab: the unfinished cards assigned to you across your team projects, grouped by project and
 * soonest due first. Double-click a task to open it in the browser; Start and Done move it along.
 */
class SVenomBoardPanel : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SVenomBoardPanel) {}
	SLATE_END_ARGS()

	void Construct(const FArguments& InArgs);

private:
	/** A row in the list: a project heading (no Task) or one task. */
	struct FRow
	{
		FString ProjectId;
		FString Label;
		TSharedPtr<FVenomTask> Task;
		TArray<TSharedPtr<FRow>> Children;
	};
	using FRowPtr = TSharedPtr<FRow>;

	TSharedRef<SWidget> MakeToolbar();
	TSharedRef<SWidget> MakeSettings();
	TSharedRef<SWidget> MakeScope();
	TSharedRef<SWidget> MakeActions();
	TSharedRef<SWidget> MakeStatusFilterMenu();
	TSharedRef<SWidget> MakeProjectMenu();

	TSharedRef<ITableRow> OnGenerateRow(FRowPtr Row, const TSharedRef<STableViewBase>& Owner);
	void OnGetChildren(FRowPtr Row, TArray<FRowPtr>& OutChildren);
	void OnSelectionChanged(FRowPtr Row, ESelectInfo::Type How);
	void OnExpansionChanged(FRowPtr Row, bool bExpanded);
	void OnDoubleClick(FRowPtr Row);
	TSharedPtr<SWidget> OnContextMenu();

	void Refresh();
	void OnTasksLoaded(const FVenomAnswer& Answer, const FString& AskedProject);
	void SetStatus(TSharedPtr<FVenomTask> Task, const FString& Status);
	void OnStatusSet(const FVenomAnswer& Answer, const FString& Key);
	void SaveSettings();

	void RebuildTree();
	TSharedPtr<FVenomTask> SelectedTask() const;
	bool CanChange(const TSharedPtr<FVenomTask>& Task) const;
	FText ProjectLabel() const;
	static FText StatusFilterName(EVenomStatusFilter Filter);
	void Say(const FString& Text, bool bError = false);

	FVenomBoardClient Client;
	TArray<TSharedPtr<FVenomTask>> Tasks;
	TArray<FVenomProject> Projects;
	TArray<FRowPtr> Roots;
	TSet<FString> Collapsed;
	TSharedPtr<STreeView<FRowPtr>> Tree;
	TSharedPtr<SEditableTextBox> ServerBox;
	TSharedPtr<SEditableTextBox> TokenBox;

	FString Filter;
	EVenomStatusFilter StatusFilter = EVenomStatusFilter::Any;
	FString ProjectId;
	FString SelectedKey;
	FString Message;
	bool bMessageIsError = false;
	bool bIncludeUnassigned = false;
	bool bShowSettings = false;
	bool bLoading = false;
	bool bLoadedOnce = false;
};
