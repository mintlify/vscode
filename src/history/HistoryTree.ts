import * as vscode from 'vscode';
import TimeAgo from 'javascript-time-ago';
import axios from 'axios';
import { MINT_SEARCH_HISTORY } from '../api';
import { ENTIRE_WORKSPACE_OPTION } from '../utils';
// @ts-ignore
import en from 'javascript-time-ago/locale/en';

TimeAgo.addDefaultLocale(en);
const timeAgo = new TimeAgo('en-US');

export default class HistoryProvider implements vscode.TreeDataProvider<SearchHistory> {
  constructor(private authToken: string | null) {}

  getTreeItem(element: SearchHistory): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SearchHistory): Promise<SearchHistory[]> {
    if (!this.authToken) {
      return Promise.resolve([]);
    }
    if (element) {
      return Promise.resolve([]);
    } else {
      const { data: { history } } = await axios.post(MINT_SEARCH_HISTORY, {
        authToken: this.authToken
      });
      const searchHistory = history.map((search: { query: string, timestamp: string }) => {
        const relativeTime = timeAgo.format(Date.parse(search.timestamp), 'round') as string;
        return new SearchHistory(search.query, relativeTime);
      });
      return Promise.resolve(searchHistory);
    }
  }
}

class SearchHistory extends vscode.TreeItem {
  constructor(
    public readonly search: string,
    private relativeTime: string
  ) {
    super(search);
    this.tooltip = `${this.search}-${this.relativeTime}`;
    this.description = this.relativeTime;

    const onClickCommand: vscode.Command = {
      title: 'Search',
      command: 'mintlify.search',
      arguments: [{
        search: this.search,
        option: ENTIRE_WORKSPACE_OPTION,
      }]
    };
    this.command = onClickCommand;
  }
}
