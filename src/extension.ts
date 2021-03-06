import * as vscode from 'vscode';
import { basename, dirname, join, normalize, relative, resolve } from 'path';
import { existsSync, writeFileSync } from 'fs';
import {
  CompletionItemProvider,
  TextDocument,
  Position,
  CancellationToken,
  CompletionContext,
  workspace,
  CompletionItem,
  CompletionItemKind,
  Uri,
} from 'vscode';

function workspaceFilenameConvention(): string | undefined {
  let cfg = vscode.workspace.getConfiguration('vscodeMarkdownNotes');
  return cfg.get('workspaceFilenameConvention');
}
function useUniqueFilenames(): boolean {
  return workspaceFilenameConvention() == 'uniqueFilenames';
}

function useRelativePaths(): boolean {
  return workspaceFilenameConvention() == 'relativePaths';
}

function filenameForConvention(uri: Uri, fromDocument: TextDocument): string {
  if (useUniqueFilenames()) {
    return basename(uri.path);
  } else {
    let toPath = uri.path;
    let fromDir = dirname(fromDocument.uri.path.toString());
    let rel = normalize(relative(fromDir, toPath));
    return rel;
  }
}

enum ContextWordType {
  Null, // 0
  WikiLink, // 1
  Tag, // 2
}

interface ContextWord {
  type: ContextWordType;
  word: string;
  hasExtension: boolean | null;
}

const NULL_CONTEXT_WORD = { type: ContextWordType.Null, word: '', hasExtension: null };

function getContextWord(document: TextDocument, position: Position): ContextWord {
  let contextWord: string;
  let regex: RegExp;
  let range: vscode.Range | undefined;

  // #tag regexp
  regex = /\#[\w\-\_]+/i;
  range = document.getWordRangeAtPosition(position, regex);
  if (range) {
    contextWord = document.getText(range);
    if (contextWord) {
      return {
        type: ContextWordType.Tag,
        word: contextWord.replace(/^\#+/, ''),
        hasExtension: null,
      };
    }
  }

  // [[wiki-link-regex
  // regex = /[\w\.\-\_\/\\]+\.(md|markdown)/i;
  regex = /\[\[[\w\.\-\_\/\\]+/i;
  range = document.getWordRangeAtPosition(position, regex);
  if (range) {
    contextWord = document.getText(range);
    if (contextWord) {
      return {
        type: ContextWordType.WikiLink,
        word: contextWord.replace(/^\[+/, ''),
        // TODO: paramaterize extensions. Add $ to end?
        hasExtension: !!contextWord.match(/\.(md|markdown)/i),
      };
    }
  }

  return NULL_CONTEXT_WORD;
}

class MarkdownFileCompletionItemProvider implements CompletionItemProvider {
  public async provideCompletionItems(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    context: CompletionContext
  ) {
    // console.debug('provideCompletionItems');
    const contextWord = getContextWord(document, position);
    if (contextWord.type != ContextWordType.WikiLink) {
      // console.debug('getContextWord was not WikiLink');
      return [];
    }

    let files = (await workspace.findFiles('**/*')).filter(
      // TODO: paramaterize extensions. Add $ to end?
      (f) => f.scheme == 'file' && f.path.match(/\.(md|markdown)/i)
    );
    let items = files.map((f) => {
      let kind = CompletionItemKind.File;
      let label = filenameForConvention(f, document);
      return new CompletionItem(label, kind);
    });
    return items;
  }
}

// TODO: read this!
// https://stackoverflow.com/questions/54285472/vscode-how-to-automatically-jump-to-proper-definition
class MarkdownDefinitionProvider implements vscode.DefinitionProvider {
  public async provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
  ) {
    // console.debug('provideDefinition');

    const contextWord = getContextWord(document, position);
    if (contextWord.type != ContextWordType.WikiLink) {
      // console.debug('getContextWord was not WikiLink');
      return [];
    }
    if (!contextWord.hasExtension) {
      // console.debug('getContextWord does not have file extension');
      return [];
    }

    // TODO: parameterize extensions. return if we don't have a filename and we require extensions
    // const markdownFileRegex = /[\w\.\-\_\/\\]+\.(md|markdown)/i;
    const selectedWord = contextWord.word;
    // console.debug('selectedWord', selectedWord);
    let files: Array<Uri> = [];
    // selectedWord might be either:
    // a basename for a unique file in the workspace
    // or, a relative path to a file
    // Since, selectedWord is just a string of text from a document,
    // there is no guarantee useUniqueFilenames will tell us
    // it is not a relative path.
    // However, only check for basenames in the entire project if:
    if (useUniqueFilenames()) {
      const filename = selectedWord;
      // there should be exactly 1 file with name = selecteWord
      files = (await workspace.findFiles('**/*')).filter((f) => {
        return basename(f.path) == filename;
      });
    }
    // If we did not find any files in the workspace,
    // see if a file exists at the relative path:
    if (files.length == 0) {
      const relativePath = selectedWord;
      let fromDir = dirname(document.uri.path.toString());
      const absPath = resolve(fromDir, relativePath);
      if (existsSync(absPath)) {
        const f = Uri.file(absPath);
        files.push(f);
      }
    }

    const p = new vscode.Position(0, 0);
    return files.map((f) => new vscode.Location(f, p));
  }
}

function newNote(context: vscode.ExtensionContext) {
  // console.debug('newNote');
  const inputBoxPromise = vscode.window.showInputBox({
    prompt:
      "Enter a 'Title Case Name' to create `title-case-name.md` with '# Title Case Name' at the top.",
    value: '',
  });

  let workspaceUri = '';
  if (vscode.workspace.workspaceFolders) {
    workspaceUri = vscode.workspace.workspaceFolders[0].uri.path.toString();
  }

  inputBoxPromise.then(
    (noteName) => {
      if (noteName == null || !noteName || noteName.replace(/\s+/g, '') == '') {
        // console.debug('Abort: noteName was empty.');
        return false;
      }

      const filename =
        noteName
          .replace(/\W+/gi, '-') // non-words to hyphens
          .toLowerCase() // lower
          .replace(/-*$/, '') + '.md'; // removing trailing '-' chars, add extension
      const filepath = join(workspaceUri, filename);

      const fileAlreadyExists = existsSync(filepath);
      // create the file if it does not exists
      if (!fileAlreadyExists) {
        const contents = `# ${noteName}\n\n`;
        writeFileSync(filepath, contents);
      }

      // open the file:
      vscode.window
        .showTextDocument(vscode.Uri.file(filepath), {
          preserveFocus: false,
          preview: false,
        })
        .then(() => {
          // if we created a new file, hop to line #3
          if (!fileAlreadyExists) {
            let editor = vscode.window.activeTextEditor;
            if (editor) {
              const lineNumber = 3;
              let range = editor.document.lineAt(lineNumber - 1).range;
              editor.selection = new vscode.Selection(range.start, range.end);
              editor.revealRange(range);
            }
          }
        });
    },
    (err) => {
      vscode.window.showErrorMessage('Error creating new note.');
      // console.error(err);
    }
  );
}

export function activate(context: vscode.ExtensionContext) {
  // console.debug('vscode-markdown-notes.activate');
  const md = { scheme: 'file', language: 'markdown' };
  vscode.languages.setLanguageConfiguration('markdown', { wordPattern: /([\#\.\/\\\w_]+)/ });

  // const triggerCharacters = ['.', '#'];
  // const triggerCharacters = [];
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(md, new MarkdownFileCompletionItemProvider())
  );
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(md, new MarkdownDefinitionProvider())
  );

  let newNoteDisposable = vscode.commands.registerCommand('vscodeMarkdownNotes.newNote', newNote);
  context.subscriptions.push(newNoteDisposable);
}
