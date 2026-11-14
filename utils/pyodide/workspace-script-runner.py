import ast
import importlib.metadata
import importlib.util
import importlib
import io
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import stat
import sys
import tempfile
import tokenize
import tomllib
import zipfile

class ScriptDependencyError(RuntimeError):
    pass

class WorkspaceScript:
    def __init__(self, request):
        self.request = request
        self.root = Path.cwd().resolve()
        self.entry = self.inside(self.root / request["path"])
        self.parts = Path(request["path"]).parts
        self.project = self.root
        # Find copied Skill roots by their manifest, never by a storage directory convention.
        for directory in self.entry.parents:
            if not directory.is_relative_to(self.root):
                break
            if (directory / "SKILL.md").is_file():
                self.project = self.inside(directory)
                break
        if "cwd" in request:
            self.project = self.inside(self.root / request["cwd"])
        self.cwd = self.inside(self.root / request["cwd"]) if "cwd" in request else self.project
        if not self.cwd.is_dir():
            raise NotADirectoryError("Script cwd does not exist: " + request.get("cwd", "."))
        if not self.entry.is_file():
            raise FileNotFoundError("Script not found: " + request["path"])
        if self.entry.suffix != ".py":
            raise ValueError("The script resolves to a non-Python file")
        self.search = list(dict.fromkeys((self.entry.parent, self.project, self.project / "src", self.cwd)))
        self.module = request.get("module")
        if self.module:
            parts = self.module.split(".")
            for base in dict.fromkeys((self.cwd, self.project, self.project / "src", self.entry.parent)):
                stem = base.joinpath(*parts)
                if self.inside(stem.with_suffix(".py")) == self.entry:
                    break
                if self.inside(stem / "__main__.py") == self.entry:
                    self.module += ".__main__"
                    break
            else:
                raise ValueError("module and scriptPath do not refer to the same workspace entry")
            self.search = list(dict.fromkeys((base, *self.search)))
        self.wheels = []
        for name in request["wheels"]:
            wheel = self.inside(self.root / name)
            if not wheel.is_file() or wheel.suffix != ".whl":
                raise FileNotFoundError("Local wheel not found: " + name)
            if not re.fullmatch(r"[A-Za-z0-9_.+-]+\.whl", wheel.name):
                raise ValueError("Invalid wheel filename: " + name)
            self.wheels.append(wheel)

    def inside(self, path):
        resolved = path.resolve()
        if not resolved.is_relative_to(self.root):
            raise ValueError("Script resource resolves outside the current workspace")
        return resolved

    def read(self, path, limit=1_000_000, python=False):
        path = self.inside(path)
        with path.open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Script or dependency manifest exceeds the inspection limit: " + path.name)
        if python:
            return data.decode(tokenize.detect_encoding(io.BytesIO(data).readline)[0])
        return data.decode("utf-8-sig")

    def declarations(self, source):
        headers = list(re.finditer(r"^# /// script\r?$", source, re.M))
        if len(headers) > 1:
            raise ValueError("Multiple PEP 723 script metadata blocks")
        if headers:
            body = []
            for line in source[headers[0].end():].splitlines()[1:]:
                if line == "# ///":
                    return self.project_metadata(tomllib.loads("\n".join(body)))
                if line != "#" and not line.startswith("# "):
                    break
                body.append(line[2:])
            raise ValueError("Unterminated PEP 723 script metadata block")
        requirements, warnings = [], []
        folders = [self.entry.parent]
        if self.entry.parent.is_relative_to(self.project):
            folders.extend(parent for parent in self.entry.parent.parents if parent.is_relative_to(self.project))
        else:
            folders.append(self.project)
        for folder in folders:
            req = self.inside(folder / "requirements.txt")
            project = self.inside(folder / "pyproject.toml")
            if req.is_file():
                for number, raw in enumerate(self.read(req, 128_000).splitlines(), 1):
                    line = re.split(r"\s+#", raw.strip(), maxsplit=1)[0]
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("-") or line.endswith("\\"):
                        warnings.append(f"{req.relative_to(self.root)}:{number}: pip options/includes/continuations require manual conversion")
                    else:
                        requirements.append(line)
                _, version, project_warnings = self.read_project(project)
                return requirements, version, warnings + project_warnings
            if project.is_file():
                return self.read_project(project)
        for name in ("uv.lock", "poetry.lock", "Pipfile", "setup.py", "setup.cfg", "package.json", "Dockerfile", "Makefile"):
            if any(self.inside(folder / name).is_file() for folder in folders):
                warnings.append(name + " may require a separate build or runtime; it is not executed")
        return requirements, "", warnings

    def read_project(self, path):
        if not path.is_file():
            return [], "", []
        data = tomllib.loads(self.read(path, 128_000))
        if "project" in data:
            return self.project_metadata(data["project"])
        return [], "", ["No static [project] metadata in pyproject.toml. Review its build or lock files."]

    @staticmethod
    def project_metadata(data):
        if not isinstance(data, dict):
            raise ValueError("Invalid dependency metadata: expected a TOML table")
        dependencies = data.get("dependencies", [])
        version = data.get("requires-python", "")
        dynamic = data.get("dynamic", [])
        if not isinstance(dependencies, list) or any(not isinstance(item, str) for item in dependencies) or not isinstance(version, str):
            raise ValueError("Invalid dependency metadata: expected dependencies as strings and requires-python as text")
        if not isinstance(dynamic, list) or any(not isinstance(item, str) for item in dynamic):
            raise ValueError("Invalid dependency metadata: dynamic must be a list of strings")
        warnings = ["Dynamic dependencies require manual review"] if "dependencies" in dynamic else []
        return dependencies, version, warnings

    def inspect(self):
        source = self.read(self.entry, python=True)
        requirements, version, warnings = self.declarations(source)
        requirements = requirements + self.request["requirements"]
        if len(requirements) > 128 or any(len(item) > 512 for item in requirements) or len(version) > 512:
            raise ValueError("Dependency declarations exceed the inspection limit")
        files = {self.entry}
        pending = [(self.entry, source)]
        imports = set()
        env = set()
        native = set()
        scan_bytes = 0

        def local_module(base, name):
            stem = base.joinpath(*name.split("."))
            for path in (stem / "__init__.py", stem.with_suffix(".py")):
                path = self.inside(path)
                if path.is_file():
                    if path not in files:
                        if len(files) >= 64:
                            warnings.append("Local import scan reached its 64-file limit")
                        else:
                            files.add(path)
                            pending.append((path, None))
                    return True
            return False

        while pending:
            path, source = pending.pop()
            source = self.read(path, python=True) if source is None else source
            scan_bytes += len(source)
            if scan_bytes > 4_000_000:
                warnings.append("Local import scan reached its total size limit")
                break
            for node in ast.walk(ast.parse(source, filename=str(path.relative_to(self.root)))):
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    base = node.module or ""
                    if node.level:
                        folder = path.parent
                        for _ in range(node.level - 1):
                            folder = folder.parent
                        if folder.is_relative_to(self.root):
                            for name in [base] + [f"{base}.{a.name}".strip(".") for a in node.names if a.name != "*"]:
                                if name:
                                    local_module(folder, name)
                        continue
                    modules = [base] + [f"{base}.{a.name}" for a in node.names if a.name != "*"]
                else:
                    if isinstance(node, ast.Call) and node.args and isinstance(node.args[0], ast.Constant):
                        func = ast.unparse(node.func) if isinstance(node.func, (ast.Name, ast.Attribute)) else ""
                        if func in ("os.getenv", "getenv", "os.environ.get", "environ.get"):
                            key = node.args[0].value
                            if isinstance(key, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", key):
                                env.add(key)
                    if isinstance(node, ast.Subscript) and isinstance(node.value, (ast.Attribute, ast.Name)) and isinstance(node.slice, ast.Constant):
                        key = node.slice.value
                        if ast.unparse(node.value) in ("os.environ", "environ") and isinstance(key, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", key):
                            env.add(key)
                    continue
                for name in modules:
                    top = name.partition(".")[0]
                    if not top or not all(part.isidentifier() for part in name.split(".")):
                        continue
                    local = any(local_module(folder, name) or (
                        name != top and local_module(folder, top)
                    ) for folder in self.search)
                    if not local and top not in sys.stdlib_module_names:
                        imports.add(top)
                    if not local and top in {"subprocess", "multiprocessing", "resource", "fcntl", "pty", "winreg"}:
                        native.add(top)

        provided = set(self.request["env"]) | {"AGENTNEXUS_WORKSPACE"}
        return {
            "scriptPath": self.request["path"], "cwd": str(self.cwd.relative_to(self.root)), "module": self.module,
            "pythonVersion": sys.version.split()[0], "requiresPython": version,
            "requirements": list(dict.fromkeys(requirements)), "imports": sorted(imports),
            "envReferences": sorted(env)[:128],
            "unsetEnvReferences": sorted(key for key in env - provided if key not in os.environ)[:128],
            "osModuleHints": sorted(native),
            "warnings": list(dict.fromkeys(warnings))[:32],
            "localWheels": self.request["wheels"], "scannedFiles": len(files),
        }

    def requirements(self, plan):
        from packaging.requirements import InvalidRequirement, Requirement
        from packaging.specifiers import SpecifierSet

        if plan["requiresPython"] and not SpecifierSet(plan["requiresPython"]).contains(plan["pythonVersion"], prereleases=True):
            raise ScriptDependencyError("Python " + plan["pythonVersion"] + " does not meet " + plan["requiresPython"])
        requirements = []
        for index, text in enumerate(plan["requirements"], 1):
            try:
                requirement = Requirement(text)
            except InvalidRequirement:
                raise ScriptDependencyError(f"Invalid or unsupported dependency declaration #{index}") from None
            if requirement.url:
                raise ScriptDependencyError("Direct URL or VCS dependency for " + requirement.name +
                    " must be replaced with a distribution specifier and a trusted compatible wheel")
            if not requirement.marker or requirement.marker.evaluate({"extra": ""}):
                requirements.append(requirement)
        return requirements

    async def prepare_dependencies(self, requirements):
        if self.wheels or self.request["dependencyMode"] == "pypi":
            import micropip
            if self.wheels:
                with tempfile.TemporaryDirectory(prefix="skill-wheels-") as stage:
                    urls = []
                    for index, wheel in enumerate(self.wheels):
                        self.check_wheel(wheel)
                        destination = Path(stage) / str(index) / wheel.name
                        destination.parent.mkdir()
                        shutil.copyfile(wheel, destination)
                        urls.append("emfs:" + str(destination))
                    # Workspace filenames may contain Unicode or URL delimiters.
                    await micropip.install(urls, deps=False)
            if requirements and self.request["dependencyMode"] == "pypi":
                try:
                    await micropip.install([str(req) for req in requirements], credentials="omit")
                except Exception as error:
                    raise ScriptDependencyError(
                        "Could not resolve compatible wheels from PyPI. Check versions, network and WASM support, or supply compatible local wheels: "
                        + str(error)
                    ) from error
        missing = []
        for req in requirements:
            try:
                installed = importlib.metadata.version(req.name)
            except importlib.metadata.PackageNotFoundError:
                missing.append(str(req))
                continue
            if req.extras and self.request["dependencyMode"] == "catalog":
                missing.append(str(req) + " (extras need explicit dependency resolution)")
            elif req.specifier and not req.specifier.contains(installed, prereleases=True):
                missing.append(f"{req} (installed: {installed})")
        if missing:
            raise ScriptDependencyError("Unsatisfied dependencies: " + ", ".join(missing) +
                ". Use compatible wheels, request PyPI resolution, or use a standard-library fallback.")

    @staticmethod
    def check_wheel(path):
        with zipfile.ZipFile(path) as wheel:
            names = set()
            expanded = 0
            for entry in wheel.infolist():
                name = entry.filename.rstrip("/")
                mode = stat.S_IFMT(entry.external_attr >> 16)
                if (not name or "\\" in name or re.match(r"^[A-Za-z]:", name)
                    or any(part in ("", ".", "..") for part in name.split("/"))
                    or mode not in (0, stat.S_IFREG, stat.S_IFDIR) or name in names):
                    raise ScriptDependencyError("Unsafe or duplicate entry in local wheel: " + path.name)
                names.add(name)
                expanded += entry.file_size
                if len(names) > 10_000 or expanded > 128 * 1024 * 1024:
                    raise ScriptDependencyError("Local wheel exceeds the expanded size limit: " + path.name)

    def run(self):
        # Resolve and retain these functions before script code can modify shared modules.
        chdir, environ = os.chdir, os.environ
        old_cwd, old_argv, old_path, old_stdin = Path.cwd(), sys.argv, sys.path, sys.stdin
        previous_env = dict(environ)
        previous_bytecode = sys.dont_write_bytecode
        def clear_workspace_modules():
            # Keep installed dependencies warm, but never retain a previous revision of a project module.
            for name, module in list(sys.modules.items()):
                try:
                    values = vars(module)
                    paths = [values.get("__file__"), *values.get("__path__", ())]
                    if any(isinstance(path, str) and Path(path).resolve().is_relative_to(self.root) for path in paths):
                        sys.modules.pop(name, None)
                except (TypeError, ValueError, OSError):
                    continue
            importlib.invalidate_caches()
        try:
            clear_workspace_modules()
            sys.dont_write_bytecode = True
            chdir(self.cwd)
            sys.path = [str(self.inside(path)) for path in self.search] + old_path
            sys.argv = [str(self.entry), *self.request["argv"]]
            sys.stdin = io.StringIO(self.request["stdin"])
            environ.update(self.request["env"])
            environ["AGENTNEXUS_WORKSPACE"] = str(self.root)
            try:
                if self.module:
                    spec = importlib.util.find_spec(self.module)
                    if not spec or not spec.origin or Path(spec.origin).resolve() != self.entry:
                        raise ImportError("Module resolution does not match scriptPath: " + self.module)
                    runpy.run_module(self.module, run_name="__main__", alter_sys=True)
                else:
                    runpy.run_path(str(self.entry), run_name="__main__")
            except SystemExit as error:
                if error.code is not None and error.code != 0:
                    raise RuntimeError(f"Script exited with status {error.code}") from None
            except ModuleNotFoundError as error:
                raise ScriptDependencyError(
                    f"{error}. Check the skill's copied resources and dependency declarations. "
                    "Import names can differ from distribution names; inspect the manifest before installing."
                ) from error
        finally:
            clear_workspace_modules()
            sys.dont_write_bytecode = previous_bytecode
            sys.argv, sys.path, sys.stdin = old_argv, old_path, old_stdin
            os.environ = environ
            environ.clear()
            environ.update(previous_env)
            chdir(old_cwd)

runner = WorkspaceScript(json.loads(request_json))
plan = runner.inspect()
json.dumps(plan, ensure_ascii=False)
