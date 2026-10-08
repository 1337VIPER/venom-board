#include "SVenomBoardPanel.h"

#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "HAL/PlatformApplicationMisc.h"
#include "HAL/PlatformProcess.h"
#include "Misc/DateTime.h"
#include "Styling/AppStyle.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Images/SImage.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SCheckBox.h"
#include "Widgets/Input/SComboButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Input/SHyperlink.h"
#include "Widgets/Input/SSearchBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"
#include "Widgets/Views/STableRow.h"

#define LOCTEXT_NAMESPACE "VenomBoard"

namespace VenomBoardPanel
{
	static const FLinearColor LateColor(FColor(0xff, 0x2a, 0x4f));
	static const FLinearColor Grey(FColor(0x9d, 0x99, 0xaa));
	static const EVenomStatusFilter AllFilters[] = { EVenomStatusFilter::Any, EVenomStatusFilter::ToDo, EVenomStatusFilter::Doing, EVenomStatusFilter::Blocked, EVenomStatusFilter::Overdue };

	static FLinearColor SwatchColor(const FString& Hex)
	{
		if (Hex.Len() == 7 && Hex.StartsWith(TEXT("#")))
		{
			return FLinearColor(FColor::FromHex(Hex));
		}
		return Grey;
	}
}

void SVenomBoardPanel::Construct(const FArguments& InArgs)
{
	Client.Load();
	bShowSettings = Client.Token.IsEmpty();

	ChildSlot
	[
		SNew(SVerticalBox)
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(4.f)
		[
			MakeToolbar()
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(4.f, 0.f, 4.f, 4.f)
		[
			MakeSettings()
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(4.f, 0.f, 4.f, 4.f)
		[
			MakeScope()
		]
		+ SVerticalBox::Slot()
		.FillHeight(1.f)
		.Padding(4.f, 0.f)
		[
			SNew(SBorder)
			.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
			.Padding(2.f)
			[
				SNew(SOverlay)
				+ SOverlay::Slot()
				[
					SAssignNew(Tree, STreeView<FRowPtr>)
					.TreeItemsSource(&Roots)
					.SelectionMode(ESelectionMode::Single)
					.OnGenerateRow(this, &SVenomBoardPanel::OnGenerateRow)
					.OnGetChildren(this, &SVenomBoardPanel::OnGetChildren)
					.OnSelectionChanged(this, &SVenomBoardPanel::OnSelectionChanged)
					.OnExpansionChanged(this, &SVenomBoardPanel::OnExpansionChanged)
					.OnMouseButtonDoubleClick(this, &SVenomBoardPanel::OnDoubleClick)
					.OnContextMenuOpening(this, &SVenomBoardPanel::OnContextMenu)
				]
				+ SOverlay::Slot()
				.HAlign(HAlign_Center)
				.VAlign(VAlign_Center)
				.Padding(12.f)
				[
					SNew(STextBlock)
					.AutoWrapText(true)
					.Justification(ETextJustify::Center)
					.ColorAndOpacity(FSlateColor::UseSubduedForeground())
					.Visibility_Lambda([this]() { return Roots.Num() == 0 && bLoadedOnce ? EVisibility::HitTestInvisible : EVisibility::Collapsed; })
					.Text_Lambda([this]()
					{
						return Tasks.Num() > 0 ? LOCTEXT("NoMatch", "Nothing matches the filter.") : LOCTEXT("NoTasks", "No unfinished tasks assigned to you.");
					})
				]
			]
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(4.f)
		[
			MakeActions()
		]
		+ SVerticalBox::Slot()
		.AutoHeight()
		.Padding(4.f, 0.f, 4.f, 4.f)
		[
			SNew(STextBlock)
			.AutoWrapText(true)
			.Text_Lambda([this]() { return FText::FromString(Message); })
			.ColorAndOpacity_Lambda([this]() { return bMessageIsError ? FSlateColor(VenomBoardPanel::LateColor) : FSlateColor::UseSubduedForeground(); })
		]
	];

	if (Client.Token.IsEmpty())
	{
		Say(TEXT("Add your access token to see your tasks. Make one on your Venom Board account page, under Connect tools (MCP)."));
	}
	else
	{
		Refresh();
	}
}

/* ---------- building the tab ---------- */

TSharedRef<SWidget> SVenomBoardPanel::MakeToolbar()
{
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		[
			SNew(SButton)
			.ButtonStyle(FAppStyle::Get(), "SimpleButton")
			.ToolTipText(LOCTEXT("RefreshTip", "Refresh"))
			.IsEnabled_Lambda([this]() { return !bLoading; })
			.OnClicked_Lambda([this]() { Refresh(); return FReply::Handled(); })
			[
				SNew(SImage)
				.Image(FAppStyle::GetBrush("Icons.Refresh"))
				.ColorAndOpacity(FSlateColor::UseForeground())
			]
		]
		+ SHorizontalBox::Slot()
		.FillWidth(1.f)
		.VAlign(VAlign_Center)
		.Padding(4.f, 0.f)
		[
			SNew(SSearchBox)
			.HintText(LOCTEXT("FilterHint", "Filter tasks"))
			.OnTextChanged_Lambda([this](const FText& Text) { Filter = Text.ToString(); RebuildTree(); })
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		[
			SNew(SComboButton)
			.ToolTipText(LOCTEXT("StatusFilterTip", "Show only tasks with this status"))
			.OnGetMenuContent(this, &SVenomBoardPanel::MakeStatusFilterMenu)
			.ButtonContent()
			[
				SNew(STextBlock).Text_Lambda([this]() { return StatusFilterName(StatusFilter); })
			]
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(4.f, 0.f, 0.f, 0.f)
		[
			SNew(SCheckBox)
			.Style(FAppStyle::Get(), "ToggleButtonCheckbox")
			.ToolTipText(LOCTEXT("SettingsTip", "Server and access token"))
			.IsChecked_Lambda([this]() { return bShowSettings ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
			.OnCheckStateChanged_Lambda([this](ECheckBoxState State) { bShowSettings = State == ECheckBoxState::Checked; })
			[
				SNew(SBox)
				.Padding(4.f)
				[
					SNew(SImage)
					.Image(FAppStyle::GetBrush("Icons.Settings"))
					.ColorAndOpacity(FSlateColor::UseForeground())
				]
			]
		];
}

TSharedRef<SWidget> SVenomBoardPanel::MakeSettings()
{
	return SNew(SBorder)
		.Visibility_Lambda([this]() { return bShowSettings ? EVisibility::Visible : EVisibility::Collapsed; })
		.BorderImage(FAppStyle::GetBrush("ToolPanel.GroupBorder"))
		.Padding(6.f)
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.f, 0.f, 0.f, 4.f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					SNew(SBox)
					.WidthOverride(52.f)
					[
						SNew(STextBlock).Text(LOCTEXT("Server", "Server"))
					]
				]
				+ SHorizontalBox::Slot()
				.FillWidth(1.f)
				[
					SAssignNew(ServerBox, SEditableTextBox)
					.Text(FText::FromString(Client.ServerUrl))
					.HintText(FText::FromString(FVenomBoardClient::DefaultServer))
				]
			]
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.f, 0.f, 0.f, 4.f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				[
					SNew(SBox)
					.WidthOverride(52.f)
					[
						SNew(STextBlock).Text(LOCTEXT("Token", "Token"))
					]
				]
				+ SHorizontalBox::Slot()
				.FillWidth(1.f)
				[
					SAssignNew(TokenBox, SEditableTextBox)
					.IsPassword(true)
					.Text(FText::FromString(Client.Token))
					.HintText(LOCTEXT("TokenHint", "vbt_..."))
					.OnTextCommitted_Lambda([this](const FText&, ETextCommit::Type How) { if (How == ETextCommit::OnEnter) { SaveSettings(); } })
				]
			]
			+ SVerticalBox::Slot()
			.AutoHeight()
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot()
				.AutoWidth()
				[
					SNew(SButton)
					.Text(LOCTEXT("Save", "Save and connect"))
					.OnClicked_Lambda([this]() { SaveSettings(); return FReply::Handled(); })
				]
				+ SHorizontalBox::Slot()
				.AutoWidth()
				.VAlign(VAlign_Center)
				.Padding(10.f, 0.f, 0.f, 0.f)
				[
					SNew(SHyperlink)
					.Text(LOCTEXT("MakeToken", "Make a token"))
					.ToolTipText(LOCTEXT("MakeTokenTip", "Opens your account page: Connect tools (MCP) makes a personal access token"))
					.OnNavigate_Lambda([this]()
					{
						FPlatformProcess::LaunchURL(*FVenomBoardClient::AccountPage(ServerBox.IsValid() ? ServerBox->GetText().ToString() : Client.ServerUrl), nullptr, nullptr);
					})
				]
			]
			+ SVerticalBox::Slot()
			.AutoHeight()
			.Padding(0.f, 4.f, 0.f, 0.f)
			[
				SNew(STextBlock)
				.AutoWrapText(true)
				.ColorAndOpacity(FSlateColor::UseSubduedForeground())
				.Text(LOCTEXT("Kept", "Kept in your editor settings on this computer, not in the project."))
			]
		];
}

TSharedRef<SWidget> SVenomBoardPanel::MakeScope()
{
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.FillWidth(1.f)
		[
			SNew(SComboButton)
			.ToolTipText(LOCTEXT("ProjectTip", "Show tasks from every project, or from one"))
			.IsEnabled_Lambda([this]() { return !bLoading; })
			.OnGetMenuContent(this, &SVenomBoardPanel::MakeProjectMenu)
			.ButtonContent()
			[
				SNew(STextBlock)
				.OverflowPolicy(ETextOverflowPolicy::Ellipsis)
				.Text_Lambda([this]() { return ProjectLabel(); })
			]
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.VAlign(VAlign_Center)
		.Padding(6.f, 0.f, 0.f, 0.f)
		[
			SNew(SCheckBox)
			.ToolTipText(LOCTEXT("UnassignedTip", "Also list this project's cards that nobody has taken yet"))
			.IsEnabled_Lambda([this]() { return !ProjectId.IsEmpty() && !bLoading; })
			.IsChecked_Lambda([this]() { return bIncludeUnassigned ? ECheckBoxState::Checked : ECheckBoxState::Unchecked; })
			.OnCheckStateChanged_Lambda([this](ECheckBoxState State) { bIncludeUnassigned = State == ECheckBoxState::Checked; Refresh(); })
			[
				SNew(STextBlock).Text(LOCTEXT("Unassigned", "Unassigned too"))
			]
		];
}

TSharedRef<SWidget> SVenomBoardPanel::MakeActions()
{
	return SNew(SHorizontalBox)
		+ SHorizontalBox::Slot()
		.AutoWidth()
		[
			SNew(SButton)
			.Text(LOCTEXT("Start", "Start"))
			.ToolTipText_Lambda([this]()
			{
				const TSharedPtr<FVenomTask> Task = SelectedTask();
				return Task.IsValid() && !Task->bCanEdit ? LOCTEXT("StartViewTip", "You can only view this project.") : LOCTEXT("StartTip", "Set the selected card to Doing");
			})
			.IsEnabled_Lambda([this]()
			{
				const TSharedPtr<FVenomTask> Task = SelectedTask();
				return CanChange(Task) && Task->Status != TEXT("doing");
			})
			.OnClicked_Lambda([this]() { SetStatus(SelectedTask(), TEXT("doing")); return FReply::Handled(); })
		]
		+ SHorizontalBox::Slot()
		.AutoWidth()
		.Padding(4.f, 0.f, 0.f, 0.f)
		[
			SNew(SButton)
			.Text(LOCTEXT("Done", "Done"))
			.ToolTipText_Lambda([this]()
			{
				const TSharedPtr<FVenomTask> Task = SelectedTask();
				return Task.IsValid() && !Task->bCanEdit ? LOCTEXT("DoneViewTip", "You can only view this project.") : LOCTEXT("DoneTip", "Mark the selected card done");
			})
			.IsEnabled_Lambda([this]() { return CanChange(SelectedTask()); })
			.OnClicked_Lambda([this]() { SetStatus(SelectedTask(), TEXT("done")); return FReply::Handled(); })
		];
}

TSharedRef<SWidget> SVenomBoardPanel::MakeStatusFilterMenu()
{
	FMenuBuilder Menu(true, nullptr);
	for (const EVenomStatusFilter Choice : VenomBoardPanel::AllFilters)
	{
		Menu.AddMenuEntry(
			StatusFilterName(Choice),
			FText::GetEmpty(),
			FSlateIcon(),
			FUIAction(
				FExecuteAction::CreateLambda([this, Choice]() { StatusFilter = Choice; RebuildTree(); }),
				FCanExecuteAction(),
				FIsActionChecked::CreateLambda([this, Choice]() { return StatusFilter == Choice; })),
			NAME_None,
			EUserInterfaceActionType::RadioButton);
	}
	return Menu.MakeWidget();
}

TSharedRef<SWidget> SVenomBoardPanel::MakeProjectMenu()
{
	FMenuBuilder Menu(true, nullptr);
	auto AddChoice = [this, &Menu](const FString& Id, const FText& Label)
	{
		Menu.AddMenuEntry(
			Label,
			FText::GetEmpty(),
			FSlateIcon(),
			FUIAction(
				FExecuteAction::CreateLambda([this, Id]()
				{
					if (Id == ProjectId)
					{
						return;
					}
					ProjectId = Id;
					if (ProjectId.IsEmpty())
					{
						bIncludeUnassigned = false;
					}
					Refresh();
				}),
				FCanExecuteAction(),
				FIsActionChecked::CreateLambda([this, Id]() { return ProjectId == Id; })),
			NAME_None,
			EUserInterfaceActionType::RadioButton);
	};
	AddChoice(FString(), LOCTEXT("AllProjects", "All projects"));
	for (const FVenomProject& Project : Projects)
	{
		const FString Count = Project.Tasks > 0 ? FString::Printf(TEXT(" (%d)"), Project.Tasks) : FString();
		AddChoice(Project.ProjectId, FText::FromString(FString::Printf(TEXT("%s - %s%s"), *Project.Project, *Project.Team, *Count)));
	}
	return Menu.MakeWidget();
}

TSharedRef<ITableRow> SVenomBoardPanel::OnGenerateRow(FRowPtr Row, const TSharedRef<STableViewBase>& Owner)
{
	if (!Row->Task.IsValid())
	{
		return SNew(STableRow<FRowPtr>, Owner)
			.Padding(FMargin(2.f, 4.f))
			[
				SNew(STextBlock)
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 9))
				.Text(FText::FromString(Row->Label))
			];
	}
	const FVenomTask& Task = *Row->Task;
	const FString Title = Task.bAssignedToYou ? Task.Title : Task.Title + TEXT("  (unassigned)");
	return SNew(STableRow<FRowPtr>, Owner)
		.Padding(FMargin(2.f, 3.f))
		[
			SNew(SHorizontalBox)
			.ToolTipText(FText::FromString(FVenomBoardClient::Describe(Task)))
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			.Padding(0.f, 0.f, 6.f, 0.f)
			[
				SNew(SBox)
				.WidthOverride(10.f)
				.HeightOverride(10.f)
				[
					SNew(SImage)
					.Image(FAppStyle::GetBrush("WhiteBrush"))
					.ColorAndOpacity(VenomBoardPanel::SwatchColor(Task.Color))
				]
			]
			+ SHorizontalBox::Slot()
			.FillWidth(1.f)
			.VAlign(VAlign_Center)
			[
				SNew(STextBlock)
				.OverflowPolicy(ETextOverflowPolicy::Ellipsis)
				.Text(FText::FromString(Title))
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			.Padding(8.f, 0.f, 0.f, 0.f)
			[
				SNew(SBox)
				.WidthOverride(64.f)
				[
					SNew(STextBlock)
					.ColorAndOpacity(FSlateColor::UseSubduedForeground())
					.Text(FText::FromString(FVenomBoardClient::StatusName(Task.Status)))
				]
			]
			+ SHorizontalBox::Slot()
			.AutoWidth()
			.VAlign(VAlign_Center)
			[
				SNew(SBox)
				.WidthOverride(84.f)
				[
					SNew(STextBlock)
					.ColorAndOpacity(Task.bOverdue ? FSlateColor(VenomBoardPanel::LateColor) : FSlateColor::UseForeground())
					.ToolTipText(FText::FromString(Task.Due))
					.Text(FText::FromString(FVenomBoardClient::DueText(Task)))
				]
			]
		];
}

void SVenomBoardPanel::OnGetChildren(FRowPtr Row, TArray<FRowPtr>& OutChildren)
{
	OutChildren = Row->Children;
}

void SVenomBoardPanel::OnSelectionChanged(FRowPtr Row, ESelectInfo::Type How)
{
	SelectedKey = Row.IsValid() && Row->Task.IsValid() ? Row->Task->Key() : FString();
}

void SVenomBoardPanel::OnExpansionChanged(FRowPtr Row, bool bExpanded)
{
	if (Row.IsValid() && !Row->Task.IsValid())
	{
		if (bExpanded)
		{
			Collapsed.Remove(Row->ProjectId);
		}
		else
		{
			Collapsed.Add(Row->ProjectId);
		}
	}
}

void SVenomBoardPanel::OnDoubleClick(FRowPtr Row)
{
	if (Row.IsValid() && Row->Task.IsValid())
	{
		FPlatformProcess::LaunchURL(*Row->Task->Link, nullptr, nullptr);
	}
	else if (Row.IsValid() && Tree.IsValid())
	{
		Tree->SetItemExpansion(Row, !Tree->IsItemExpanded(Row));
	}
}

TSharedPtr<SWidget> SVenomBoardPanel::OnContextMenu()
{
	const TSharedPtr<FVenomTask> Task = SelectedTask();
	if (!Task.IsValid())
	{
		return nullptr;
	}
	FMenuBuilder Menu(true, nullptr);
	Menu.AddMenuEntry(
		LOCTEXT("Open", "Open in browser"),
		LOCTEXT("OpenTip", "Opens the card on its board"),
		FSlateIcon(),
		FUIAction(FExecuteAction::CreateLambda([Task]() { FPlatformProcess::LaunchURL(*Task->Link, nullptr, nullptr); })));
	Menu.AddMenuEntry(
		LOCTEXT("Copy", "Copy link"),
		FText::GetEmpty(),
		FSlateIcon(),
		FUIAction(FExecuteAction::CreateLambda([this, Task]() { FPlatformApplicationMisc::ClipboardCopy(*Task->Link); Say(TEXT("Link copied.")); })));
	Menu.AddSeparator();
	auto AddStatus = [this, &Menu, Task](const FText& Label, const FString& Status)
	{
		Menu.AddMenuEntry(
			Label,
			Task->bCanEdit ? FText::GetEmpty() : LOCTEXT("ViewOnly", "You can only view this project."),
			FSlateIcon(),
			FUIAction(
				FExecuteAction::CreateLambda([this, Task, Status]() { SetStatus(Task, Status); }),
				FCanExecuteAction::CreateLambda([this, Task, Status]() { return CanChange(Task) && (Task->Status != Status || Status == TEXT("done")); })));
	};
	AddStatus(LOCTEXT("MenuStart", "Start (Doing)"), TEXT("doing"));
	AddStatus(LOCTEXT("MenuDone", "Mark done"), TEXT("done"));
	AddStatus(LOCTEXT("MenuBlocked", "Mark blocked"), TEXT("blocked"));
	AddStatus(LOCTEXT("MenuTodo", "Back to To do"), TEXT("todo"));
	return Menu.MakeWidget();
}

/* ---------- talking to the server ---------- */

void SVenomBoardPanel::Refresh()
{
	if (bLoading)
	{
		return;
	}
	bLoading = true;
	Say(TEXT("Loading..."));
	const FString Asked = ProjectId;
	const TWeakPtr<SVenomBoardPanel> Weak = SharedThis(this);
	Client.CallTool(TEXT("my_tasks"), FVenomBoardClient::MyTasksArguments(FVenomBoardClient::Today(), Asked, bIncludeUnassigned), [Weak, Asked](const FVenomAnswer& Answer)
	{
		if (const TSharedPtr<SVenomBoardPanel> Self = Weak.Pin())
		{
			Self->OnTasksLoaded(Answer, Asked);
		}
	});
}

void SVenomBoardPanel::OnTasksLoaded(const FVenomAnswer& Answer, const FString& AskedProject)
{
	bLoading = false;
	if (!Answer.IsOk())
	{
		Say(Answer.Error, true);
		return;
	}
	TArray<FVenomProject> NewProjects;
	FString Note;
	FVenomBoardClient::ReadTasks(*Answer.Result, Tasks, NewProjects, Note);
	if (AskedProject.IsEmpty())
	{
		Projects = MoveTemp(NewProjects);
	}
	bLoadedOnce = true;
	RebuildTree();
	int32 Late = 0;
	for (const TSharedPtr<FVenomTask>& Task : Tasks)
	{
		Late += Task->bOverdue ? 1 : 0;
	}
	FString Summary = Tasks.Num() == 0 ? FString(TEXT("No unfinished tasks assigned to you")) : Tasks.Num() == 1 ? FString(TEXT("1 task")) : FString::Printf(TEXT("%d tasks"), Tasks.Num());
	if (Late > 0)
	{
		Summary += FString::Printf(TEXT(", %d overdue"), Late);
	}
	if (!Note.IsEmpty())
	{
		Summary += TEXT(". ") + Note.LeftChop(Note.EndsWith(TEXT(".")) ? 1 : 0);
	}
	Say(Summary + TEXT(". Updated ") + FDateTime::Now().ToString(TEXT("%H:%M")) + TEXT("."));
}

void SVenomBoardPanel::SetStatus(TSharedPtr<FVenomTask> Task, const FString& Status)
{
	if (!Task.IsValid() || bLoading)
	{
		return;
	}
	if (!Task->bCanEdit)
	{
		Say(FString::Printf(TEXT("You can only view %s, so you can't change its cards."), *Task->Project), true);
		return;
	}
	bLoading = true;
	Say(TEXT("Saving..."));
	const FString Key = Task->Key();
	const TWeakPtr<SVenomBoardPanel> Weak = SharedThis(this);
	Client.CallTool(TEXT("set_card_status"), FVenomBoardClient::SetStatusArguments(*Task, Status, FVenomBoardClient::Today()), [Weak, Key](const FVenomAnswer& Answer)
	{
		if (const TSharedPtr<SVenomBoardPanel> Self = Weak.Pin())
		{
			Self->OnStatusSet(Answer, Key);
		}
	});
}

void SVenomBoardPanel::OnStatusSet(const FVenomAnswer& Answer, const FString& Key)
{
	bLoading = false;
	if (!Answer.IsOk())
	{
		Say(Answer.Error, true);
		return;
	}
	const TSharedPtr<FJsonObject>* Row = nullptr;
	if (!Answer.Result->TryGetObjectField(TEXT("task"), Row) || !Row || !Row->IsValid())
	{
		Refresh();
		return;
	}
	const TSharedPtr<FVenomTask> Updated = FVenomBoardClient::ReadTask(**Row);
	const int32 Index = Tasks.IndexOfByPredicate([&Key](const TSharedPtr<FVenomTask>& Task) { return Task->Key() == Key; });
	if (Index != INDEX_NONE)
	{
		if (Updated->Status == TEXT("done"))
		{
			Tasks.RemoveAt(Index);
		}
		else
		{
			Tasks[Index] = Updated;
		}
	}
	RebuildTree();
	Say(FVenomBoardClient::StatusChanged(*Updated));
}

void SVenomBoardPanel::SaveSettings()
{
	const FString NewToken = TokenBox.IsValid() ? TokenBox->GetText().ToString().TrimStartAndEnd() : Client.Token;
	if (!NewToken.IsEmpty() && !FVenomBoardClient::LooksLikeToken(NewToken))
	{
		Say(TEXT("That doesn't look like a Venom Board access token: they start with vbt_. Copy the whole token from your account page."), true);
		return;
	}
	Client.ServerUrl = FVenomBoardClient::NormaliseServer(ServerBox.IsValid() ? ServerBox->GetText().ToString() : Client.ServerUrl);
	Client.Token = NewToken;
	Client.Save();
	if (ServerBox.IsValid())
	{
		ServerBox->SetText(FText::FromString(Client.ServerUrl));
	}
	if (NewToken.IsEmpty())
	{
		Tasks.Reset();
		Projects.Reset();
		RebuildTree();
		Say(TEXT("Token removed. Add one to see your tasks."));
		return;
	}
	bShowSettings = false;
	Projects.Reset();
	ProjectId.Reset();
	bIncludeUnassigned = false;
	Refresh();
}

/* ---------- the list ---------- */

void SVenomBoardPanel::RebuildTree()
{
	Roots.Reset();
	TMap<FString, FRowPtr> Groups;
	for (const TSharedPtr<FVenomTask>& Task : Tasks)
	{
		if (!FVenomBoardClient::Matches(*Task, Filter, StatusFilter))
		{
			continue;
		}
		FRowPtr& Group = Groups.FindOrAdd(Task->ProjectId);
		if (!Group.IsValid())
		{
			Group = MakeShared<FRow>();
			Group->ProjectId = Task->ProjectId;
			Roots.Add(Group);
		}
		FRowPtr Item = MakeShared<FRow>();
		Item->ProjectId = Task->ProjectId;
		Item->Task = Task;
		Group->Children.Add(Item);
	}
	FRowPtr Reselect;
	for (const FRowPtr& Group : Roots)
	{
		const FVenomTask& First = *Group->Children[0]->Task;
		Group->Label = FString::Printf(TEXT("%s - %s (%d)"), *First.Project, *First.Team, Group->Children.Num());
		for (const FRowPtr& Child : Group->Children)
		{
			if (Child->Task->Key() == SelectedKey)
			{
				Reselect = Child;
			}
		}
	}
	if (!Tree.IsValid())
	{
		return;
	}
	const FString Keep = SelectedKey;
	Tree->RequestTreeRefresh();
	for (const FRowPtr& Group : Roots)
	{
		Tree->SetItemExpansion(Group, !Collapsed.Contains(Group->ProjectId));
	}
	if (Reselect.IsValid())
	{
		Tree->SetSelection(Reselect);
	}
	else
	{
		Tree->ClearSelection();
	}
	SelectedKey = Reselect.IsValid() ? Keep : FString();
}

TSharedPtr<FVenomTask> SVenomBoardPanel::SelectedTask() const
{
	if (!Tree.IsValid())
	{
		return nullptr;
	}
	const TArray<FRowPtr> Selected = Tree->GetSelectedItems();
	return Selected.Num() > 0 && Selected[0].IsValid() ? Selected[0]->Task : nullptr;
}

bool SVenomBoardPanel::CanChange(const TSharedPtr<FVenomTask>& Task) const
{
	return Task.IsValid() && Task->bCanEdit && !bLoading;
}

FText SVenomBoardPanel::ProjectLabel() const
{
	for (const FVenomProject& Project : Projects)
	{
		if (Project.ProjectId == ProjectId)
		{
			return FText::FromString(FString::Printf(TEXT("%s - %s"), *Project.Project, *Project.Team));
		}
	}
	return LOCTEXT("AllProjects", "All projects");
}

FText SVenomBoardPanel::StatusFilterName(EVenomStatusFilter Choice)
{
	switch (Choice)
	{
	case EVenomStatusFilter::ToDo: return LOCTEXT("FilterTodo", "To do");
	case EVenomStatusFilter::Doing: return LOCTEXT("FilterDoing", "Doing");
	case EVenomStatusFilter::Blocked: return LOCTEXT("FilterBlocked", "Blocked");
	case EVenomStatusFilter::Overdue: return LOCTEXT("FilterOverdue", "Overdue");
	default: return LOCTEXT("FilterAny", "Any status");
	}
}

void SVenomBoardPanel::Say(const FString& Text, bool bError)
{
	Message = Text;
	bMessageIsError = bError;
}

#undef LOCTEXT_NAMESPACE
