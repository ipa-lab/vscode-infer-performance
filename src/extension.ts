import * as vscode from 'vscode';
import { DetailCodelensProvider } from './DetailCodelensProvider';
import { OverviewCodelensProvider } from './OverviewCodelensProvider';
import { InferCostItem } from './CustomTypes';
import { getMethodDeclarations, isExpensiveMethod } from './CommonFunctions';

const childProcess = require('child_process');
const fs = require('fs');

const inferOutputDirectory = '/tmp/infer-out';

let currentInferCost: InferCostItem[];
let inferCosts = new Map<vscode.TextDocument, InferCostItem[]>();   // [document, inferCost]
let inferCostHistories = new Map<string, InferCostItem[]>();        // [inferCostItem.id, costHistory]

let disposables: vscode.Disposable[] = [];
let activeTextEditor: vscode.TextEditor;

// [sourceFileName, codeLensDisposable]
let overviewCodeLensProviderDisposables = new Map<string, vscode.Disposable>();
let detailCodeLensProviderDisposables = new Map<string, vscode.Disposable>();

let webviewOverview: vscode.WebviewPanel;
let webviewHistory: vscode.WebviewPanel;

// Decorator types that we use to decorate method declarations
let methodDeclarationDecorationType: vscode.TextEditorDecorationType;
let methodNameDecorationType: vscode.TextEditorDecorationType;
let methodNameDecorationTypeExpensive: vscode.TextEditorDecorationType;
let areDecorationTypesSet: boolean = false;

// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "infer-for-vscode" is now active!');

  let disposableCommand = vscode.commands.registerCommand("infer-for-vscode.executeInfer", () => {
    vscode.workspace.getConfiguration("infer-for-vscode").update("enableInfer", true, true);

    if (!areDecorationTypesSet) {
      initializeDecorationTypes();
    }

    const tmpActiveTextEditor = vscode.window.activeTextEditor;
    if (tmpActiveTextEditor) {
      activeTextEditor = tmpActiveTextEditor;
    } else { return; }

    const tmpInferCost = executeInferOnCurrentFile();
    if (tmpInferCost) {
      currentInferCost = tmpInferCost;
      inferCosts.set(activeTextEditor.document, tmpInferCost);
    } else { return; }

    updateInferCostHistory();

    createCodeLenses();
    createEditorDecorators();

    vscode.window.showInformationMessage('Infer has been executed.');
  });
  disposables.push(disposableCommand);
  context.subscriptions.push(disposableCommand);

  disposableCommand = vscode.commands.registerCommand("infer-for-vscode.disableInfer", () => {
    disableInfer();
  });
  disposables.push(disposableCommand);
  context.subscriptions.push(disposableCommand);

  disposableCommand = vscode.commands.registerCommand("infer-for-vscode.detailCodelensAction", (methodKey: string) => {
    createWebviewHistory(methodKey);
  });
  disposables.push(disposableCommand);
  context.subscriptions.push(disposableCommand);

  disposableCommand = vscode.commands.registerCommand("infer-for-vscode.overviewCodelensAction", (document: vscode.TextDocument, selectedMethodName: string) => {
    createWebviewOverview(document, selectedMethodName);
  });
  disposables.push(disposableCommand);
  context.subscriptions.push(disposableCommand);

  vscode.window.onDidChangeActiveTextEditor(editor => {
    if (editor) {
      activeTextEditor = editor;
      const tmpInferCost = inferCosts.get(activeTextEditor.document);
      if (tmpInferCost) {
        currentInferCost = tmpInferCost;
        createEditorDecorators();
      }
    }
  }, null, context.subscriptions);

  vscode.workspace.onDidChangeTextDocument(event => {
    if (activeTextEditor && event.document === activeTextEditor.document) {
      createEditorDecorators();
    }
  }, null, context.subscriptions);
}

// this method is called when your extension is deactivated
export function deactivate() {
  if (fs.existsSync(inferOutputDirectory)) {
    let inferOut = vscode.Uri.file(inferOutputDirectory);
    vscode.workspace.fs.delete(inferOut, {recursive: true});
  }
  disableInfer();
  if (disposables) {
    disposables.forEach(item => item.dispose());
  }
  disposables = [];
}

function disableInfer() {
  vscode.workspace.getConfiguration("infer-for-vscode").update("enableInfer", false, true);

  if (areDecorationTypesSet) {
    methodDeclarationDecorationType.dispose();
    methodNameDecorationType.dispose();
    methodNameDecorationTypeExpensive.dispose();

    areDecorationTypesSet = false;
  }

  for (const codeLensProviderMapEntry of detailCodeLensProviderDisposables) {
    codeLensProviderMapEntry[1].dispose();
  }
  for (const codeLensProviderMapEntry of overviewCodeLensProviderDisposables) {
    codeLensProviderMapEntry[1].dispose();
  }

  if (webviewOverview) {
    webviewOverview.dispose();
  }
  if (webviewHistory) {
    webviewHistory.dispose();
  }
}

function initializeDecorationTypes() {
  methodDeclarationDecorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: ' (warn about significant changes here)',
      color: '#ff0000'
    }
  });
  methodNameDecorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(150, 255, 10, 0.5)',
    overviewRulerColor: 'rgba(150, 250, 50, 1)',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  methodNameDecorationTypeExpensive = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.7)',
    overviewRulerColor: '#ff0000',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  areDecorationTypesSet = true;
}

function executeInferOnCurrentFile() {
  const sourceFilePath = activeTextEditor.document.fileName;
  if (!sourceFilePath.endsWith(".java")) {
    vscode.window.showInformationMessage('Infer can only be executed on Java files.');
    console.log("Tried to execute Infer on non-Java file.");
    return undefined;
  }
  const sourceFileName = sourceFilePath.split("/").pop()?.split(".")[0];
  childProcess.execSync(`infer --cost -o ${inferOutputDirectory}/${sourceFileName} -- javac ${sourceFilePath}`);

  let inferCost: InferCostItem[] = [];
  try {
    const inferCostJsonString = fs.readFileSync(`${inferOutputDirectory}/${sourceFileName}/costs-report.json`);
    let inferCostRaw = JSON.parse(inferCostJsonString);
    for (let inferCostRawItem of inferCostRaw) {
      inferCost.push({
        id: `${sourceFilePath}:${inferCostRawItem.procedure_name}`,
        method_name: inferCostRawItem.procedure_name,
        loc: {
          file: inferCostRawItem.loc.file,
          lnum: inferCostRawItem.loc.lnum
        },
        alloc_cost: {
          polynomial: inferCostRawItem.alloc_cost.hum.hum_polynomial,
          degree: inferCostRawItem.alloc_cost.hum.hum_degree,
          big_o: inferCostRawItem.alloc_cost.hum.big_o
        },
        exec_cost: {
          polynomial: inferCostRawItem.exec_cost.hum.hum_polynomial,
          degree: inferCostRawItem.exec_cost.hum.hum_degree,
          big_o: inferCostRawItem.exec_cost.hum.big_o
        }
      });
    }
  } catch (err) {
    console.log(err);
    console.log("InferCost file could not be read.");
    return undefined;
  } finally {
    if (fs.existsSync(`${inferOutputDirectory}/${sourceFileName}`)) {
      let inferOut = vscode.Uri.file(`${inferOutputDirectory}/${sourceFileName}`);
      vscode.workspace.fs.delete(inferOut, {recursive: true});
    }
  }
  return inferCost.sort((a: InferCostItem, b: InferCostItem) => a.loc.lnum - b.loc.lnum);
}

function updateInferCostHistory() {
  let currentTime = new Date().toLocaleString('en-US', { hour12: false });
  for (const inferCostItem of currentInferCost) {
    let costHistory: InferCostItem[] | undefined = [];
    if (inferCostHistories.has(inferCostItem.id)) {
      costHistory = inferCostHistories.get(inferCostItem.id);
    }
    if (!costHistory) { return; }
    if ((costHistory.length > 0) && (costHistory[0].exec_cost.polynomial === inferCostItem.exec_cost.polynomial)) {
      continue;
    }
    inferCostItem.timestamp = currentTime;
    costHistory.unshift(inferCostItem);
    inferCostHistories.set(inferCostItem.id, costHistory);
  }
}

function createCodeLenses() {
  const sourceFileName = activeTextEditor.document.fileName.split("/").pop();
  const docSelector: vscode.DocumentSelector = { pattern: `**/${sourceFileName}`, language: 'java' };
  if (!sourceFileName) { return; }

  overviewCodeLensProviderDisposables.get(sourceFileName)?.dispose();
  let codeLensProviderDisposable = vscode.languages.registerCodeLensProvider(docSelector, new OverviewCodelensProvider());
  overviewCodeLensProviderDisposables.set(sourceFileName, codeLensProviderDisposable);

  detailCodeLensProviderDisposables.get(sourceFileName)?.dispose();
  codeLensProviderDisposable = vscode.languages.registerCodeLensProvider(docSelector, new DetailCodelensProvider(currentInferCost));
  detailCodeLensProviderDisposables.set(sourceFileName, codeLensProviderDisposable);
}

function createEditorDecorators() {
  const methodDeclarations = getMethodDeclarations(activeTextEditor.document);

  const methodDeclarationDecorations: vscode.DecorationOptions[] = [];
  const methodNameDecorations: vscode.DecorationOptions[] = [];
  const methodNameDecorationsExpensive: vscode.DecorationOptions[] = [];
  for (let inferCostItem of currentInferCost) {
    methodDeclarations.some(methodDeclaration => {
      if (inferCostItem.method_name === methodDeclaration.name) {
        const declarationDecoration = { range: methodDeclaration.declarationRange };
        const nameDecoration = { range: methodDeclaration.nameRange, hoverMessage: `Execution cost: ${inferCostItem.exec_cost.polynomial} -- ${inferCostItem.exec_cost.big_o}` };
        methodDeclarationDecorations.push(declarationDecoration);
        if (isExpensiveMethod(inferCostItem.method_name, currentInferCost)) {
          methodNameDecorationsExpensive.push(nameDecoration);
        } else {
          methodNameDecorations.push(nameDecoration);
        }
        return true;
      }
    });
  }
  activeTextEditor.setDecorations(methodDeclarationDecorationType, methodDeclarationDecorations);
  activeTextEditor.setDecorations(methodNameDecorationType, methodNameDecorations);
  activeTextEditor.setDecorations(methodNameDecorationTypeExpensive, methodNameDecorationsExpensive);
}

function createWebviewOverview(document: vscode.TextDocument, selectedMethodName: string) {
  if (webviewOverview) {
    webviewOverview.dispose();
  }

  // Create and show a new webview panel
  webviewOverview = vscode.window.createWebviewPanel(
    'inferCostOverview', // Identifies the type of the webview. Used internally
    'Infer Cost Overview', // Title of the panel displayed to the user
    {viewColumn: vscode.ViewColumn.Two, preserveFocus: true}, // Editor column to show the new webview panel in.
    {localResourceRoots: []} // Webview options.
  );

  let inferCostOverviewHtmlString = "";
  for (let inferCostItem of currentInferCost) {
    if (inferCostItem.method_name === '<init>') { continue; }
    inferCostOverviewHtmlString += `<div${inferCostItem.method_name === selectedMethodName ? ' class="selected-method"' : ''}>
<h2>${inferCostItem.method_name} (line ${inferCostItem.loc.lnum})</h2>
<div>Allocation cost: ${inferCostItem.alloc_cost.polynomial} : ${inferCostItem.alloc_cost.big_o}</div>
<div>Execution cost: ${inferCostItem.exec_cost.polynomial} : ${inferCostItem.exec_cost.big_o}</div>
</div>
<hr>`;
  }

  webviewOverview.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Infer Cost Overview</title>
  <style>
.selected-method {
  background-color: rgba(200, 200, 0, 0.2);
}
  </style>
</head>
<body>
  <h1>Infer Cost Overview</h1>
  <div>
    <hr>
    ${inferCostOverviewHtmlString}
  <div>
</body>
</html>`;
}

function createWebviewHistory(methodKey: string) {
  if (webviewHistory) {
    webviewHistory.dispose();
  }

  // Create and show a new webview panel
  webviewHistory = vscode.window.createWebviewPanel(
    'inferCostHistory', // Identifies the type of the webview. Used internally
    'Infer Cost History', // Title of the panel displayed to the user
    {viewColumn: vscode.ViewColumn.Two, preserveFocus: true}, // Editor column to show the new webview panel in.
    {localResourceRoots: []} // Webview options.
  );

  const costHistory = inferCostHistories.get(methodKey);
  if (!costHistory || costHistory.length <= 0) { return; }
  let inferCostHistoryHtmlString = ``;
  for (let costHistoryItem of costHistory) {
    inferCostHistoryHtmlString += `<div>
<h2>${costHistoryItem.timestamp + (costHistoryItem === costHistory[0] ? ' (most recent)' : '')}</h2>
<div>Allocation cost: ${costHistoryItem.alloc_cost.polynomial} : ${costHistoryItem.alloc_cost.big_o}</div>
<div>Execution cost: ${costHistoryItem.exec_cost.polynomial} : ${costHistoryItem.exec_cost.big_o}</div>
</div>
<hr>`;
  }

  webviewHistory.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Infer Cost History</title>
</head>
<body>
  <h1>Infer Cost History for: ${costHistory[0].method_name} (line ${costHistory[0].loc.lnum})</h1>
  <div>
    <hr>
    ${inferCostHistoryHtmlString}
  <div>
</body>
</html>`;
}