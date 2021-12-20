import * as vscode from 'vscode';
import axios from 'axios';
import { showErrorMessage,
	showLoginMessage, showStatusBarItem,
	showSettings,
	configUserSettings,
	refreshHistoryTree,
	changePickerColorScheme,
	removePickerColorScheme,
	showSkippedFileTypesMessage } from './helpers/ui';
import { getRootPath } from './helpers/content';
import { MINT_SEARCH_DESCRIPTION,
	REQUEST_ACCESS_BUTTON,
	LOGOUT_BUTTON, ANSWER_BOX_FEEDBACK } from './constants/content';
import { getLogoutURI, MINT_SEARCH_AUTOCOMPLETE,
	MINT_SEARCH_RESULTS, MINT_SEARCH_FEEDBACK,
	MINT_SEARCH_ANSWER_BOX_FEEDBACK, MINT_IS_USER_HAPPY } from './constants/api';
import HistoryProviderProvider from './history/HistoryTree';
import { LocalStorageService, SearchResult, TraversedFileData } from './constants/types';
import { preprocess } from './helpers/content';
import { initializeAuth } from './url';

export function activate(context: vscode.ExtensionContext) {
	// Set storage manager for auth tokens
	const storageManager = new LocalStorageService(context.globalState);
	const authToken: string | null = storageManager.getValue('authToken');
	if (!authToken) {
		showLoginMessage();
	}

	let isPreprocessing = false;

	// Set default settings
	configUserSettings();
	showStatusBarItem();
	refreshHistoryTree();
	initializeAuth(storageManager);

	const searchbar = vscode.commands.registerCommand('mintlify.searchbar', async () => {
		changePickerColorScheme();
		const searchPick = vscode.window.createQuickPick();
		searchPick.title = "Mintlify";
		searchPick.placeholder = "What would you like to find?";
		searchPick.show();
		
		const authToken = storageManager.getValue('authToken');
		isPreprocessing = true;
		let skippedFileTypes: Set<string>;
		preprocess(authToken, (skippedFiles) => {
			isPreprocessing = false;
			skippedFileTypes = skippedFiles;
		});
		searchPick.onDidChangeValue(async (value: string) => {
			if (!value) {
				return searchPick.items = [];
			}

			let itemResults: vscode.QuickPickItem[] = [];
			let autoSuggestions: string[] = [];
			itemResults = [
				{label: value, description: MINT_SEARCH_DESCRIPTION },
			];

			searchPick.items = itemResults;

			if (authToken) {
				const { data: autoCompleteData }: {data: string[]} = await axios.post(MINT_SEARCH_AUTOCOMPLETE, {
					query: value,
					root: getRootPath(),
					authToken,
				});

				autoSuggestions = autoCompleteData;
			}
			const autoSuggestionResults = autoSuggestions.map((suggestion) => {
				return {
					label: suggestion,
					alwaysShow: true,
				};
			});
			itemResults = [
				{label: value, description: MINT_SEARCH_DESCRIPTION },
				...autoSuggestionResults
			];

			return searchPick.items = itemResults;
		});
		
		let isGettingResults = false;
		searchPick.onDidChangeSelection(async (selectedItems) => {
			const selected = selectedItems[0];

			const { label: search } = selected;
			if (!search) {
				return null;
			}

			if (!authToken) {
				return showLoginMessage();
			}

			searchPick.value = search;
			vscode.commands.executeCommand('mintlify.search', { search, skippedFileTypes, onGetResults: () => {
				isGettingResults = true;
				searchPick.hide();
			}});
		});

		searchPick.onDidHide(() => {
			if (!isGettingResults) {
				removePickerColorScheme();
			}
		});
	});

	type ResponseResults = {
		results: SearchResult[],
		answer: string | null,
		objectID: string,
		errors?: string[],
		shouldAskForFeedback?: boolean
	};

	const searchCommand = vscode.commands.registerCommand('mintlify.search', async (
		{ search, skippedFileTypes, onGetResults = () => {} }
	) => {
		changePickerColorScheme();
		const root = getRootPath();
		const authToken = storageManager.getValue('authToken');

		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: '🔎 Mint searching across the workspace',
		},
		() => {
			return new Promise(async (resolve, reject) => {
				let resultsCount = 0;
				const waitForPreprocessing = async (timeElapsed = 0) => {
					if (timeElapsed > 10000) {
						vscode.window.showErrorMessage('Unable to process files for search');
						isPreprocessing = false;
						return reject();
					}
					if (isPreprocessing) {
						const timeoutDuration = 50;
						setTimeout(() => waitForPreprocessing(timeElapsed + timeoutDuration), timeoutDuration);
					} else {
						try {
						const searchRes: { data: ResponseResults } = await axios.post(MINT_SEARCH_RESULTS, {
							search,
							root,
							authToken
						}, {
							maxContentLength: Infinity,
							maxBodyLength: Infinity,
						});
	
						onGetResults();
						const { results: searchResults, answer, objectID, errors: searchErrors, shouldAskForFeedback } = searchRes.data;
						searchErrors?.map((error: string) => {
							vscode.window.showWarningMessage(error);
						});
	
						let lastContent = '';
						let spacesId = '';
						const searchResultsWithSpacesId: SearchResult[] = searchResults.map((result) => {
							if (result.content === lastContent) {
								spacesId += ' ';
							} else {
								spacesId = '';
							}
							
							lastContent = result.content;
	
							return {
								...result,
								content: result.content + spacesId,
							};
						});
	
						let answerBoxLineCount = 0;
						let resultItems: vscode.QuickPickItem[] = searchResultsWithSpacesId.map((result) => {
							return {
								label: '↦',
								description: result.content,
								detail: result.filename,
							};
						});
	
						// Inject answer to the front
						if (answer) {
							const answerByLine = answer.replace(/(?![^\n]{1,64}$)([^\n]{1,64})\s/g, '$1\n').split('\n');
							answerBoxLineCount = answerByLine.length;
							const itemsByLine =  answerByLine.map((line: string, i: number) => {
								return {
									label: i === 0 ? `$(lightbulb) ${line}` : line,
									alwaysShow: true
								};
							});
							resultItems = [...itemsByLine, ...resultItems];
							resultsCount = resultItems.length;
						} else if (resultItems.length === 0) {
							resultsCount = 0;
							if (skippedFileTypes != null && skippedFileTypes.size > 0) {
								resultItems = [
									{
										label: '📢',
										description: 'The languages in your codebase are not supported.',
										alwaysShow: true,
									}
								];
							} else {
								resultItems = [
									{
										label: '📭',
										description: 'No results found. Try broadening your search',
										alwaysShow: true,
									}
								];
							}
						} else if (resultItems.length > 0) {
							if (skippedFileTypes != null && skippedFileTypes.size > 0) {
								showSkippedFileTypesMessage(skippedFileTypes);
							}
						}
	
						const resultsPick = vscode.window.createQuickPick();
						resultsPick.items = resultItems;
						resultsPick.title = "Mint Search Results";
						resultsPick.placeholder = search;
						if (resultsCount > 0) {
							resultsPick.placeholder += ` - ${resultsCount} results`;
						}
						resultsPick.matchOnDescription = true;
						resultsPick.matchOnDetail = true;
						resultsPick.show();
	
						resultsPick.onDidChangeActive(async (activeItems) => {
							const item = activeItems[0];
							const itemContext = searchResultsWithSpacesId.find(
								(searchResult) => searchResult.content === item.description && searchResult.filename === item.detail
							);
	
							if (!itemContext) {return null;}
	
							const { path, lineStart, lineEnd } = itemContext;
							const filePathUri = vscode.Uri.parse(path);
							const startPosition = new vscode.Position(lineStart, 0);
							const endPosition = new vscode.Position(lineEnd, 9999);
							const selectedRange = new vscode.Range(startPosition, endPosition);
	
							await vscode.window.showTextDocument(filePathUri, {
								selection: selectedRange,
								preserveFocus: true,
							});
						});
	
						resultsPick.onDidChangeSelection(async (selectedItems) => {
							const selectedItem = selectedItems[0];
							let selectedIndex = resultsPick.items.findIndex(
								(result) => result.label === selectedItem.label
								&& result.description === selectedItem.description
								&& result.detail === selectedItem.detail
							);
	
							const isAnswerBoxSelected = selectedIndex < answerBoxLineCount;
							if (isAnswerBoxSelected) {
								axios.put(MINT_SEARCH_FEEDBACK, {
									authToken,
									objectID,
									isAnswerBoxSelected
								});
	
								const { useful, notEnoughInfo, incorrect } = ANSWER_BOX_FEEDBACK.selections;
								vscode.window.showInformationMessage(ANSWER_BOX_FEEDBACK.label, useful.text, notEnoughInfo.text, incorrect.text)
									.then(async (selection) => {
										let answerBoxFeedbackScore;
										switch (selection) {
											case useful.text:
												answerBoxFeedbackScore = useful.score;
												break;
											case notEnoughInfo.text:
												answerBoxFeedbackScore = notEnoughInfo.score;
												break;
											case incorrect.text:
												answerBoxFeedbackScore = incorrect.score;
												break;
											default:
												break;
										}
	
										try {
											await axios.put(MINT_SEARCH_ANSWER_BOX_FEEDBACK, {
												authToken,
												objectID,
												score: answerBoxFeedbackScore
											});
		
											vscode.window.showInformationMessage('Your feedback has been submitted');
										} catch {
											vscode.window.showErrorMessage('An error has occurred while submitting feedback');
										}
									});
								
								resultsPick.hide();
								return;
							}
	
							if (answerBoxLineCount > 0) {
								selectedIndex -= answerBoxLineCount;
							}
	
							const selectedResult = searchResultsWithSpacesId[selectedIndex];
	
							const { path, lineStart, lineEnd } = selectedResult;
							const filePathUri = vscode.Uri.parse(path);
							const startPosition = new vscode.Position(lineStart, 0);
							const endPosition = new vscode.Position(lineEnd, 9999);
							const selectedRange = new vscode.Range(startPosition, endPosition);
							await vscode.window.showTextDocument(filePathUri, {
								selection: selectedRange,
							});
	
							try {
								axios.put(MINT_SEARCH_FEEDBACK, {
									authToken,
									objectID,
									engagedIndex: selectedIndex,
								});
							}
							catch (error: any) {
								const backendError = error?.response?.data;
								if (backendError) {
									const { shouldPromptWaitlist } = backendError;
									showErrorMessage(backendError.error,
										shouldPromptWaitlist && REQUEST_ACCESS_BUTTON,
										shouldPromptWaitlist && LOGOUT_BUTTON
									);
								}
							}
						});
	
						resultsPick.onDidHide(async () => {
							removePickerColorScheme();
							if (shouldAskForFeedback) {
								const answer = await vscode.window.showInformationMessage('Are you happy with Mint Search?', '👍 Yes', '🙅‍♂️ No');
								let isHappy;
								switch (answer) {
									case '👍 Yes':
										isHappy = true;
										break;
									case '🙅‍♂️ No':
										isHappy = false;
										break;
									default:
										break;
								}
	
								if (isHappy != null) {
									try {
										const feedbackResponse = await axios.post(MINT_IS_USER_HAPPY, { authToken, isHappy });
										vscode.window.showInformationMessage(feedbackResponse.data.message);
									} catch {
										vscode.window.showErrorMessage('Error submitting feedback');
									}
								}
							}
						});
						vscode.commands.executeCommand('mintlify.refreshHistory');
	
						resolve('Completed search');
					} catch (error: any) {
						reject('Failed');
						console.log(error);
						const backendError = error?.response?.data;
						if (backendError) {
							const { shouldPromptWaitlist } = backendError;
							showErrorMessage(backendError.error,
								shouldPromptWaitlist && REQUEST_ACCESS_BUTTON,
								shouldPromptWaitlist && LOGOUT_BUTTON
							);
						}
					}
					};
				};

				waitForPreprocessing();
			});
		});
	});

	const refreshHistory = vscode.commands.registerCommand('mintlify.refreshHistory', async () => {
		const authToken = storageManager.getValue('authToken');
		// Get history
		const searchHistoryTree = new HistoryProviderProvider(authToken);
		vscode.window.createTreeView('history', {
			treeDataProvider: searchHistoryTree
		});
	});

	const logout = vscode.commands.registerCommand('mintlify.logout', async () => {
		const logoutURI = getLogoutURI(vscode.env.uriScheme);
		vscode.env.openExternal(vscode.Uri.parse(logoutURI));
	});

	const settings = vscode.commands.registerCommand('mintlify.settings', async () => {
		const authToken = storageManager.getValue('authToken');
		showSettings(authToken != null);
	});

	context.subscriptions.push(searchbar, searchCommand, refreshHistory, logout, settings);
}

// this method is called when your extension is deactivated
export function deactivate() {
	removePickerColorScheme();
}
