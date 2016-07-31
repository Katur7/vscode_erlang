
import * as vscode from 'vscode';
import * as fs from 'fs'
import * as rebar from './RebarRunner';
import * as erlang from './ErlangShell';
import * as path from 'path';


var myoutputChannel = erlang.ErlangShell.ErlangOutput;
var eunitDirectory = ".eunit";
var myExtensionPath = "";

export function runEUnitCommand() {
    runEUnitRequirements().then(_ => {
        myoutputChannel.clear();
        logTitle("Read configuration...");
        return readRebarConfigWithErlangShell();
    })
        .then(v => {
            //add file type to compile
            v.TestDirs = v.TestDirs.map(x => joinPath(x, "*.erl"));
            return v;
        })
        .then(x => {
            logTitle("Compile units tests...");
            return compile(x);
        })
        .then(v => {
            logTitle("Run units tests...");
            return runTests(v);
        })
        .then(testResults => {
            //TODO: may be show results in specific window
         })
        .then(x => x, reason => {
            myoutputChannel.appendLine('eunit command failed :' + reason + '\n');
        })
        ;
}

export function setExtensionPath(extensionPath : string) {
    myExtensionPath = extensionPath;
}

function joinPath(x : String, y : String) : string {
    return x + "/" + y;
}

function logTitle(title: string) {
    myoutputChannel.appendLine("------------------------------------------");
    myoutputChannel.appendLine(title);
    myoutputChannel.appendLine("------------------------------------------");
}

function runEUnitRequirements(): Thenable<boolean> {
    return new Promise<Boolean>((a, r) => {
        var rebarConfig = path.join(vscode.workspace.rootPath, "rebar.config");
        if (fs.existsSync(rebarConfig)) {
            a(true);
        }
        else {
            r("rebar.config is missing !");
        }
    });
}

function readRebarConfigWithErlangShell(): Thenable<CompileArgs> {
    return new Promise<CompileArgs>((a, r) => {

        var erlangShell = new erlang.ErlangShell();
        erlangShell.Start(vscode.workspace.rootPath, []).then(
            _ => {
                var compileArgs = new CompileArgs();
                var content = fs.readFileSync(path.join(vscode.workspace.rootPath, "rebarconfig.json"), "utf-8");
                var o = JSON.parse(content);
                compileArgs.IncludeDirs = o.IncludeDirs;
                if (compileArgs.IncludeDirs) {
                    //ADD -I before each élément
                    insertBeforeEachElement(compileArgs.IncludeDirs, "-I");
                }
                compileArgs.TestDirs = o.TestDirs;
                //todo: test if TestDirs is not empty
                a(compileArgs);
            },
            exitCode => {
                r("Erlang shell that get rebar config failed with exitcode :" + exitCode);
            });
        var cmd = '{ok, Config}=file:consult("./rebar.config"),';
        //read erl_opts
        cmd += 'E=proplists:get_value(erl_opts, Config),';
        //get includes dirs
        cmd += 'I=proplists:get_value(i, (case E of (undefined) -> []; (_)-> E end)),';
        //read eunit_compile_opts
        cmd += 'EunitOpts=proplists:get_value(eunit_compile_opts, Config),';
        //get src_dirs
        cmd += 'SrcDirs=proplists:get_value(src_dirs, (case EunitOpts of (undefined) -> []; (_)-> EunitOpts end)),';
        //get erlang tuples as printable chars
        cmd += 'IR=lists:flatten(io_lib:print((case io_lib:printable_list(I) of true -> [I]; false -> I end))),';
        //json representation
        cmd += 'R = "{\\"TestDirs\\":"++lists:flatten(io_lib:print(SrcDirs))++", \\"IncludeDirs\\":"++IR++"}",';
        cmd += 'file:write_file("./rebarconfig.json", R),'
        cmd += 'q().';
        //send command to current erlang shell  
        erlangShell.Send(cmd);
    });
}

function to_modulename(moduleFileName: string): string {
    var parsedModuleFileName = path.parse(moduleFileName);
    return parsedModuleFileName.name;
}

function relativeTo(ref: string, value: string): string {
    var parsedValue = path.parse(value);
    if (parsedValue.dir.startsWith(ref)) {
        return path.join(".", parsedValue.dir.substring(ref.length), parsedValue.base);
    }
    return value;
}

function relativePathTo(ref: string, value: string): string {
    var parsedValue = path.parse(value);
    if (parsedValue.dir.startsWith(ref)) {
        return path.join(".", parsedValue.dir.substring(ref.length));
    }
    return value;
}

function findErlangFiles(dirAndPattern: string): Thenable<String[]> {
    //find file from the root of current workspace
    return vscode.workspace.findFiles(dirAndPattern, "").then((files: vscode.Uri[]) => {
        return files.map((v, i, a) => relativeTo(vscode.workspace.rootPath, v.fsPath));
    });
}

function mapToFirstDirLevel(x: vscode.Uri): String {
    var y = relativeTo(vscode.workspace.rootPath, x.fsPath);    
    return y.split(path.sep)[0];
}

function findIncludeDirectories(): Thenable<string[]> {
    return vscode.workspace.findFiles("**/*.hrl", "").then((files: vscode.Uri[]) => {
        var iDirs = files.map(x => mapToFirstDirLevel(x));
        insertBeforeEachElement(iDirs, "-I");
        return iDirs;
    });
}

function insertBeforeEachElement(A: String[], value: String) {
    var startIndex = A.length - 1;
    var count = A.length;
    for (var index = 0; index < count; index++) {
        A.splice(startIndex - index, 0, value);
    }
}

function cleanDirectory(dir : string) {
    fs.readdirSync(dir).forEach(element => {
        var file = path.resolve(dir, element);
        var stats = fs.statSync(file);
        if (stats && stats.isFile()) {
            fs.unlinkSync(file);
        }
    });
}

function compile(compileArgs: CompileArgs): Thenable<string[]> {
    var eunitDir = path.join(vscode.workspace.rootPath, eunitDirectory);
    if (fs.existsSync(eunitDir)) {
        cleanDirectory(eunitDir);
    }
    if (!fs.existsSync(eunitDir)) {
        fs.mkdirSync(eunitDir);
    }
    fs.createReadStream(path.resolve(myExtensionPath, 'samples', 'eunit_jsonreport.erl'))
        .pipe(fs.createWriteStream(path.resolve(eunitDir, 'eunit_jsonreport.erl')));
    return findIncludeDirectories()
        .then(iDirs => {
            compileArgs.IncludeDirs = compileArgs.IncludeDirs.concat(iDirs);
            return compileArgs;
        }).then(args => {
            return findErlangFiles("{" + compileArgs.TestDirs.join(",") + "}").then(erlFiles => {
                args.ErlangFiles = erlFiles.concat(['./.eunit/eunit_jsonreport.erl']);
                return args;
            });
        }).then(args => {
            var argsCmd = args.IncludeDirs.concat(["-o", eunitDirectory]).concat(args.ErlangFiles);
            var erlc = new erlang.ErlangCompilerShell();
            return erlc.Start(vscode.workspace.rootPath, argsCmd.map<string>(x => x.toString()))
                .then(exitCode => {
                    return args.ErlangFiles;
                });
        });
}

function walkdir(dir: string, done: (err: NodeJS.ErrnoException, files: string[]) => void, accept: (dirName: string, fullPath: string) => boolean) {
    //custom function, because 'vscode.workspace.findFiles' use files.exclude from .vscode/settings.json
    //so some files are hidden (i.e *.beam) 
    var results = [];
    fs.readdir(dir, (err, list) => {
        if (err) return done(err, null);
        var pending = list.length;
        if (!pending) return done(null, results);
        list.forEach((fileName) => {
            var file = path.resolve(dir, fileName);
            fs.stat(file, (err, stat) => {
                if (stat && stat.isDirectory()) {
                    if (accept(fileName, file)) {
                        results.push(file);
                    }
                    walkdir(file, (err, res) => {
                        results = results.concat(res);
                        if (!--pending) done(null, results);
                    }, accept);
                } else {
                    //results.push(file);
                    if (!--pending) done(null, results);
                }
            });
        });
    });
}

function findebinDirs(): Thenable<string[]> {
    return new Promise<string[]>((a, r) => {
        walkdir(vscode.workspace.rootPath, (err, files) => {
            if (err) r(err);
            a(files.map(x => relativePathTo(vscode.workspace.rootPath, path.resolve(x, "dummy.txt"))));
        },
        //accept only directory that contains ebin 
        (dirName, fullPath) => dirName.match(/ebin/gi) != null)
    });
}

function runTests(filenames: string[]): Thenable<TestResults> {
    return findebinDirs().then(pzDirs => {
        return new Promise<TestResults>((a, r) => {
            var erlangShell = new erlang.ErlangShell();
            var moduleNames = filenames.map((v, i, a) => to_modulename(v));
            insertBeforeEachElement(pzDirs, "-pz");
            var args = pzDirs.concat(["-pz", "./" + eunitDirectory]);
            erlangShell.Start(vscode.workspace.rootPath, args).then(
                _ => {
                    var jsonResults = fs.readFileSync(path.resolve(vscode.workspace.rootPath, ".eunit", "testsuite_results.json"), "utf-8")
                    var typedResults = (<TestResults>JSON.parse(jsonResults));
                    if (typedResults.failed > 0 || typedResults.aborted > 0) {
                        var failed = Number(typedResults.failed)+Number(typedResults.aborted);
                        r((failed) + " unittest(s) failed.");
                    } else {
                        a(typedResults);
                    }
                },
                exitCode => {
                    r("Erlang shell that run tests failed with exitcode :" + exitCode);
                });
            //send command to current erlang shell  
            erlangShell.Send('eunit:test([' + moduleNames.join(',') + '],[{report,{eunit_jsonreport,[{dir,"' + eunitDirectory + '"}]}}]),q().');
        });
    });
}

class CompileArgs {
    TestDirs: String[];
    IncludeDirs: String[];
    ErlangFiles: String[];
}

class TestResults {
    name : string;
    time : number;
    output : any;
    succeeded : number;
    failed :number;
    aborted:number;
    skipped:number;
    testcases:TestCase[];    
}

class TestCase {
    displayname:string;
    description:string;
    module:string;
    function:string;
    arity:number;
    line:number;
    result:string;
    time:string;
    output:any;
}
