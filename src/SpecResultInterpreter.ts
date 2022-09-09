import * as vscode from 'vscode';
import * as fs from 'fs';
import * as tmp from 'tmp';
import * as chokidar from 'chokidar';
import * as path from 'path';
import { isRspecOutput } from './util';
import { RspecException, RspecOutput, TestResultException, TestResults } from './types';
import { SpecRunnerConfig } from './SpecRunnerConfig';
import SpecResultPresenter from './SpecResultPresenter';

export class SpecResultInterpreter {
  private config: SpecRunnerConfig;
  private presenter: SpecResultPresenter;
  private passedGutter: vscode.TextEditorDecorationType;
  private stalePassedGutter: vscode.TextEditorDecorationType;
  private failedGutter: vscode.TextEditorDecorationType;
  private pendingGutter: vscode.TextEditorDecorationType;
  private stalePendingGutter: vscode.TextEditorDecorationType;
  private failedLine: vscode.TextEditorDecorationType;

  private _tmpOutputFile!: tmp.FileResult;

  constructor(config: SpecRunnerConfig, context: vscode.ExtensionContext, presenter: SpecResultPresenter) {
    this.config = config;
    this.presenter = presenter;

    this.passedGutter = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(__dirname, '..', 'resources', 'passed.svg'), overviewRulerColor: '#69e06dba', overviewRulerLane: vscode.OverviewRulerLane.Center });
    this.stalePassedGutter = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(__dirname, '..', 'resources', 'passed_stale.svg'), overviewRulerColor: '#69e06dba', overviewRulerLane: vscode.OverviewRulerLane.Center });
    this.pendingGutter = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(__dirname, '..', 'resources', 'pending.svg'), overviewRulerColor: '#e0be69ba', overviewRulerLane: vscode.OverviewRulerLane.Center });
    this.stalePendingGutter = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(__dirname, '..', 'resources', 'pending_stale.svg'), overviewRulerColor: '#e0be69ba', overviewRulerLane: vscode.OverviewRulerLane.Center });
    this.failedGutter = vscode.window.createTextEditorDecorationType({ gutterIconPath: path.join(__dirname, '..', 'resources', 'failed.svg'), overviewRulerColor: '#e06969ba', overviewRulerLane: vscode.OverviewRulerLane.Center });
    this.failedLine = vscode.window.createTextEditorDecorationType({ backgroundColor: '#dc113766', overviewRulerColor: '#dc113766', overviewRulerLane: vscode.OverviewRulerLane.Right });

    context.subscriptions.push(this.passedGutter);
    context.subscriptions.push(this.stalePassedGutter);
    context.subscriptions.push(this.pendingGutter);
    context.subscriptions.push(this.stalePendingGutter);
    context.subscriptions.push(this.failedGutter);
    context.subscriptions.push(this.failedLine);
  }

  get outputFilePath() {
    return this.outputFile.name;
  }


  updateFromTestFileChange() {
    throw new Error('Method not implemented.');
  }

  updateFromOutputFile() {
    fs.readFile(this.outputFilePath, { encoding: 'utf-8' }, (err, data) => {
      if (err) {
        console.error('SpecRunner: Error reading rspec output file.', err);
        return;
      }

      this.updateFromOutputJson(data.toString());
    });
  }

  async updateFromOutputJson(json: string) {
    try {
      const results = JSON.parse(json);
      if (isRspecOutput(results)) {
        await this.updateFromRspecOutput(results);
        return;
      }

      console.info('SpecRunner: Rspec output file updated, but did not contain readable results.');
    } catch (error: any) {
      console.error('SpecRunner: Error parsing rspec output file.', error);
    }
  }

  async updateFromRspecOutput(output: RspecOutput) {
    const { examples } = output;
    const testRun = Date.now().toString();
    const testResults: TestResults = {};

    // eslint-disable-next-line @typescript-eslint/naming-convention
    await Promise.all(examples.map(async ({ file_path, line_number, id, status, exception }) => {
      const absoluteFilePath = await this.testFilePath(file_path);
      const fileResults = testResults[absoluteFilePath] ||= {
        testRun,
        testRunPending: false,
        results: {}
      };

      const file = vscode.workspace.textDocuments.find((doc) => doc.fileName === absoluteFilePath);

      fileResults.results[line_number.toString()] = {
        id,
        testRun,
        line: line_number,
        content: this.contentAtLine(file, line_number),
        status,
        exception: this.exceptionContent(exception, file)
      };
    }));

    this.presenter.setTestResults(testResults);
  }

  private exceptionContent(exception?: RspecException, file?: vscode.TextDocument): TestResultException | undefined {
    if (!exception) { return undefined; }

    const testException: TestResultException = {
      type: exception.class,
      message: exception.message
    };

    if (!file) { return testException; }

    const exceptionLine = exception.backtrace.find(traceLine => new RegExp(`^${file.fileName}:\\d+:in`).test(traceLine));
    if (!exceptionLine) { return testException; }

    const match = exceptionLine.match(/:(\d+):in/);
    testException.line = parseInt(match![1]);
    testException.content = this.contentAtLine(file, testException.line);

    return testException;
  }

  private contentAtLine(file: vscode.TextDocument | undefined, line: number) {
    // If we can't access the file we will set the content to the current time
    // which effectively means the content is unknown.
    return file?.getText(new vscode.Range(line - 1, 0, line - 1, 1000)) || Date.now().toString();
  }

  private async testFilePath(maybeARelativeFilePath: string) {
    if (maybeARelativeFilePath.startsWith('.')) {
      try {
        // attempt to replace the relative path with an absolute path using the workspace root
        return maybeARelativeFilePath.replace(/^\./, this.config.projectPath);
      } catch (error: any) {
        if (error?.name === 'NoWorkspaceError') {
          // We are unable to figure out the workspace root so we will try and find the file
          const files = await vscode.workspace.findFiles(maybeARelativeFilePath.replace(/^\.[\/\\]/, ''));

          if (files.length) {
            return files[0].fsPath;
          }
        }

        throw error;
      }
    }

    return maybeARelativeFilePath;
  }

  private get outputFile() {
    return this._tmpOutputFile ||= this.createTempFile();
  }

  private createTempFile() {
    const file = tmp.fileSync({ postfix: '.json' });

    chokidar.watch(file.name).on('change', (_event, _path) => this.updateFromOutputFile());

    return file;
  }
}

export default SpecResultInterpreter;
