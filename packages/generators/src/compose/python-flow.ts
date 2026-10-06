/**
 * The flow half of the Python composite runtime (`anvil_compose`): `Flow`,
 * its run record, and the compensation plan. Appended to the core in
 * `python.ts`; one module on disk, two here only to keep each file small.
 */
export const PYTHON_FLOW = String.raw`# -- flows ---------------------------------------------------------------------------


class StepHandle(object):
    """What Flow.step returns: pass it (or .ref(path)) as another step's input."""

    def __init__(self, flow: "Flow", step_id: str) -> None:
        self.flow = flow
        self.id = step_id

    def ref(self, path: str = "") -> Ref:
        return Ref(self.id, path)

    def __getitem__(self, path: Any) -> Ref:
        return Ref(self.id, "[%d]" % path if isinstance(path, int) else str(path))

    def __repr__(self) -> str:
        return "<step %s>" % self.id


class FlowRun(object):
    """What run() / dry_run() return. Nothing in it is undone unless you call compensate()."""

    def __init__(self, flow: str, dry_run: bool) -> None:
        self.flow = flow
        self.dry_run = dry_run
        self.status = "succeeded"
        self.steps: Dict[str, Dict[str, Any]] = {}
        self.order: List[str] = []
        self.failed_step: Optional[str] = None
        self.error: Optional[Dict[str, Any]] = None
        self.compensation: List[Dict[str, Any]] = []

    @property
    def ok(self) -> bool:
        return self.status == "succeeded"

    def output(self, step: str) -> Any:
        return self.steps[step].get("result")

    def to_json(self) -> Dict[str, Any]:
        return {
            "schema": RUN_SCHEMA,
            "flow": self.flow,
            "dry_run": self.dry_run,
            "status": self.status,
            "order": list(self.order),
            "failed_step": self.failed_step,
            "error": self.error,
            "steps": self.steps,
            "compensation": self.compensation,
        }

    def __repr__(self) -> str:
        return "<FlowRun %s %s>" % (self.flow, self.status)


def _error_dict(error: BaseException) -> Dict[str, Any]:
    if isinstance(error, ComposeError):
        return error.to_dict()
    code = getattr(error, "code", None)
    if isinstance(code, str):
        return {"code": code, "message": getattr(error, "message", None) or str(error),
                "details": getattr(error, "details", None) or {}}
    return {"code": "internal_error", "message": "%s: %s" % (type(error).__name__, error), "details": {}}


class Flow(object):
    """A DAG of connector calls.

    Build it with step()/map(); read it with plan(), validate(), mermaid(),
    to_json(); exercise it with dry_run(); execute it with run(); undo what a
    run did, when you decide to, with compensate().
    """

    def __init__(self, composite: Composite, name: str) -> None:
        self.composite = composite
        self.name = name
        self._steps: List[Dict[str, Any]] = []

    # -- building --

    def _add(self, raw: Dict[str, Any]) -> StepHandle:
        if any(s["id"] == raw["id"] for s in self._steps):
            raise ComposeError("duplicate_step", "step id %r is used twice" % raw["id"], {"step": raw["id"]})
        self._steps.append(raw)
        return StepHandle(self, raw["id"])

    def step(self, step_id: str, operation: str, args: Optional[Dict[str, Any]] = None, *,
             connector: Optional[str] = None, after: Iterable[Any] = (), when: Optional[Dict[str, Any]] = None,
             confirm: bool = False, idempotency_key: Optional[str] = None, **kwargs: Any) -> StepHandle:
        """One call. Inputs come from args= and/or keywords; a Ref/StepHandle input is a dependency."""
        merged = dict(args or {})
        merged.update(kwargs)
        raw: Dict[str, Any] = {"id": step_id, "operation": operation, "args": _encode(merged)}
        if connector:
            raw["connector"] = connector
        after_ids = [a.id if isinstance(a, StepHandle) else str(a) for a in after]
        if after_ids:
            raw["after"] = after_ids
        if when is not None:
            raw["when"] = _encode(when)
        if confirm:
            raw["confirm"] = True
        if idempotency_key is not None:
            raw["idempotency_key"] = idempotency_key
        return self._add(raw)

    def map(self, step_id: str, operation: str, over: Any, args: Optional[Dict[str, Any]] = None,
            **options: Any) -> StepHandle:
        """One call per element of *over* (a step or Ref yielding a list); item() is the element.

        The step's result is the list of each call's result, in order.
        """
        handle = self.step(step_id, operation, args, **options)
        raw = self._steps[-1]
        raw["for_each"] = _encode(over if isinstance(over, Ref) else ref(over))
        return handle

    def to_json(self) -> Dict[str, Any]:
        return {"schema": FLOW_SCHEMA, "name": self.name, "steps": json.loads(json.dumps(self._steps))}

    # -- reading --

    def _depends_on(self, raw: Dict[str, Any]) -> List[str]:
        deps: List[str] = []
        sources = [raw.get("args"), raw.get("for_each"), raw.get("when")]
        for value in sources:
            for dep in _refs_in(value):
                if dep not in deps:
                    deps.append(dep)
        for dep in raw.get("after") or []:
            if dep not in deps:
                deps.append(dep)
        return deps

    def _order(self) -> Tuple[List[str], List[List[str]]]:
        """Topological order and the waves (steps whose dependencies are all in earlier waves)."""
        ids = [s["id"] for s in self._steps]
        deps = {s["id"]: [d for d in self._depends_on(s) if d in ids] for s in self._steps}
        done: List[str] = []
        waves: List[List[str]] = []
        remaining = list(ids)
        while remaining:
            wave = [i for i in remaining if all(d in done for d in deps[i])]
            if not wave:
                raise ComposeError("cycle", "steps %s depend on each other" % ", ".join(remaining),
                                   {"steps": remaining})
            waves.append(wave)
            done.extend(wave)
            remaining = [i for i in remaining if i not in wave]
        return done, waves

    def validate(self) -> List[Dict[str, Any]]:
        """Findings ({level, code, step, message}); any 'error' stops run() before a call is sent."""
        findings: List[Dict[str, Any]] = []

        def add(level: str, code: str, step: Optional[str], message: str) -> None:
            findings.append({"level": level, "code": code, "step": step, "message": message})

        ids = [s["id"] for s in self._steps]
        for raw in self._steps:
            sid = raw["id"]
            for dep in self._depends_on(raw):
                if dep not in ids:
                    add("error", "unknown_step", sid, "depends on step %r, which is not in the flow" % dep)
                elif dep == sid:
                    add("error", "cycle", sid, "depends on itself")
            try:
                cid, op = self.composite.resolve(raw["operation"], raw.get("connector"))
            except ComposeError as error:
                add("error", error.code, sid, error.message)
                continue
            if _uses_item(raw.get("args")) and "for_each" not in raw:
                add("error", "item_outside_map", sid, "uses item() but is not a map step")
            args = raw.get("args") or {}
            try:
                given = set(_normalise(op, args))
            except ComposeError as error:
                add("error", error.code, sid, error.message)
                given = set(args)
            for needed in op["inputs"]:
                if needed["required"] and needed["key"] not in given:
                    add("error", "missing_input", sid, "%s needs input %r" % (op["id"], needed["key"]))
            if op["confirm"] and not raw.get("confirm"):
                add("error", "confirmation_required", sid,
                    "%s needs confirmation; set confirm on the step only if the task asks for this effect" % op["id"])
            if op["idempotencyKeyRequired"] and not raw.get("idempotency_key") and "for_each" not in raw:
                add("error", "idempotency_required", sid, "%s needs an idempotency_key" % op["id"])
            if op["effect"] == "mutation" and op["effectClass"] == "irreversible":
                add("warning", "irreversible", sid,
                    "%s cannot be undone; a later failure cannot be compensated for this step" % op["id"])
            if op["effect"] == "mutation" and "for_each" in raw and op["idempotencyKeyRequired"]:
                add("error", "idempotency_required", sid,
                    "%s needs a key per call, and a map step has one key; split the step" % op["id"])
        try:
            self._order()
        except ComposeError as error:
            add("error", "cycle", None, error.message)
        return findings

    def plan(self) -> Dict[str, Any]:
        """The DAG as data: nodes (connector, operation, effect, depends_on), edges, waves. Nothing is sent."""
        nodes = []
        edges = []
        for raw in self._steps:
            deps = self._depends_on(raw)
            node: Dict[str, Any] = {"id": raw["id"], "operation": raw["operation"], "depends_on": deps}
            try:
                cid, op = self.composite.resolve(raw["operation"], raw.get("connector"))
                node.update({
                    "connector": cid,
                    "qualified": "%s:%s" % (cid, op["id"]),
                    "effect": op["effect"],
                    "effect_class": op["effectClass"],
                    "confirm": bool(op["confirm"]),
                    "undo": op.get("undo", {}).get("kind") if op.get("undo") else None,
                })
            except ComposeError as error:
                node["error"] = error.to_dict()
            if "for_each" in raw:
                node["for_each"] = raw["for_each"]
            if "when" in raw:
                node["when"] = raw["when"]
            nodes.append(node)
            edges.extend([[dep, raw["id"]] for dep in deps])
        try:
            _, waves = self._order()
        except ComposeError:
            waves = []
        writes = [n for n in nodes if n.get("effect") == "mutation"]
        return {
            "schema": PLAN_SCHEMA,
            "name": self.name,
            "nodes": nodes,
            "edges": edges,
            "waves": waves,
            "connectors": sorted({n["connector"] for n in nodes if "connector" in n}),
            "summary": {
                "steps": len(nodes),
                "reads": len(nodes) - len(writes),
                "writes": len(writes),
                "irreversible": [n["id"] for n in writes if n.get("effect_class") == "irreversible"],
            },
        }

    def mermaid(self) -> str:
        lines = ["flowchart TD"]
        for node in self.plan()["nodes"]:
            label = "%s<br/>%s" % (node["id"], node.get("qualified", node["operation"]))
            shape = ("[[%s]]" if node.get("effect") == "mutation" else "[%s]") % label
            lines.append("  %s%s" % (re.sub(r"\W", "_", node["id"]), shape))
            for dep in node["depends_on"]:
                lines.append("  %s --> %s" % (re.sub(r"\W", "_", dep), re.sub(r"\W", "_", node["id"])))
        return "\n".join(lines)

    # -- executing --

    def dry_run(self) -> FlowRun:
        """Every step through its SDK's gates with dry_run, in order; refs to results become placeholders."""
        return self._execute(dry_run=True)

    def run(self) -> FlowRun:
        """Validate, then call each step in dependency order; stop at the first failure.

        A failed run carries .compensation: the undo of each completed write,
        newest first, resolved from what was sent and answered. Nothing is
        undone; call compensate() if that is what the task wants.
        """
        return self._execute(dry_run=False)

    def _execute(self, dry_run: bool) -> FlowRun:
        result = FlowRun(self.name, dry_run)
        errors = [f for f in self.validate() if f["level"] == "error"]
        if errors:
            result.status = "refused"
            result.error = {"code": "invalid_flow", "message": "the flow has %d error(s)" % len(errors),
                            "details": {"findings": errors}}
            return result
        order, _ = self._order()
        by_id = {s["id"]: s for s in self._steps}
        outputs: Dict[str, Any] = {}
        completed: List[Tuple[str, str, Dict[str, Any], List[Tuple[Dict[str, Any], Any]]]] = []
        for sid in order:
            raw = by_id[sid]
            cid, op = self.composite.resolve(raw["operation"], raw.get("connector"))
            record: Dict[str, Any] = {"operation": op["id"], "connector": cid, "status": "not_run"}
            result.steps[sid] = record
            if result.failed_step is not None:
                continue
            result.order.append(sid)
            if "when" in raw and not dry_run and not _condition_holds(raw["when"], outputs):
                record["status"] = "skipped"
                continue
            calls: List[Tuple[Dict[str, Any], Any]] = []
            try:
                if "for_each" in raw:
                    items = _resolve(raw["for_each"], outputs, _MISSING, dry_run)
                    if dry_run and not isinstance(items, list):
                        items = [_MISSING]
                    if not isinstance(items, list):
                        raise ComposeError("not_a_list", "step %r maps over a value that is not a list" % sid)
                    answers = []
                    for element in items:
                        args = _resolve(raw.get("args") or {}, outputs, element, dry_run)
                        answer = self._call(cid, op, raw, args, dry_run)
                        calls.append((args, answer))
                        answers.append(answer)
                    outputs[sid] = answers
                else:
                    args = _resolve(raw.get("args") or {}, outputs, _MISSING, dry_run)
                    answer = self._call(cid, op, raw, args, dry_run)
                    calls.append((args, answer))
                    outputs[sid] = answer
                record["status"] = "ok"
                record["result"] = outputs[sid]
                if not dry_run and op["effect"] == "mutation":
                    completed.append((sid, cid, op, calls))
            except Exception as error:  # noqa: BLE001 - every failure is reported, none is swallowed silently
                if not dry_run and op["effect"] == "mutation" and calls:
                    completed.append((sid, cid, op, calls))
                record["status"] = "failed"
                record["error"] = _error_dict(error)
                record["calls_completed"] = len(calls)
                result.status = "failed"
                result.failed_step = sid
                result.error = record["error"]
        if result.status == "failed":
            result.compensation = _compensation(completed)
        return result

    def _call(self, cid: str, op: Dict[str, Any], raw: Dict[str, Any], args: Dict[str, Any], dry_run: bool) -> Any:
        return self.composite.call(op["id"], args, connector=cid, confirm=bool(raw.get("confirm")),
                                   idempotency_key=raw.get("idempotency_key"), dry_run=dry_run)

    def compensate(self, run: FlowRun, *, confirm: bool = False, dry_run: bool = False) -> List[Dict[str, Any]]:
        """Run the undo calls a failed run reported, newest first. Your decision, never automatic.

        An undo that itself needs confirmation is refused unless confirm=True.
        Returns one outcome per entry; entries with no undo are reported, not run.
        """
        outcomes: List[Dict[str, Any]] = []
        for entry in run.compensation:
            if "undo" not in entry:
                outcomes.append(dict(entry, status="not_undoable"))
                continue
            undo = entry["undo"]
            try:
                answer = self.composite.call(undo["operation"], undo["arguments"], connector=entry["connector"],
                                             confirm=confirm, dry_run=dry_run)
                outcomes.append(dict(entry, status="ok", result=answer))
            except Exception as error:  # noqa: BLE001
                outcomes.append(dict(entry, status="failed", error=_error_dict(error)))
        return outcomes


def _source(source: Any, request: Dict[str, Any], response: Any) -> Any:
    if isinstance(source, dict) and "const" in source:
        return source["const"]
    text = str(source)
    optional = text.endswith("?")
    text = text[:-1] if optional else text
    root, _, path = text.partition(".")
    if root == "request":
        found = _walk(request, path)
    elif root == "response":
        found = _walk(response, path)
    else:
        found = _MISSING
    if found is _MISSING and optional:
        return None
    return found


def _compensation(completed: List[Tuple[str, str, Dict[str, Any], List[Tuple[Dict[str, Any], Any]]]]) -> List[Dict[str, Any]]:
    """The undo of every completed write call, newest first (ADR-0030 mappings)."""
    plan: List[Dict[str, Any]] = []
    for sid, cid, op, calls in reversed(completed):
        for index in reversed(range(len(calls))):
            request, response = calls[index]
            entry: Dict[str, Any] = {"step": sid, "call": index, "connector": cid, "operation": op["id"],
                                     "effect_class": op["effectClass"]}
            undo = op.get("undo")
            if not undo:
                entry["reason"] = "%s is %s: nothing undoes it" % (op["id"], op["effectClass"])
                plan.append(entry)
                continue
            arguments: Dict[str, Any] = {}
            gap = None
            for name, source in undo["arguments"].items():
                value = _source(source, request, response)
                if value is _MISSING:
                    gap = "%s names nothing in this call" % (source,)
                    break
                if value is not None:
                    arguments[name] = value
            if gap:
                entry["reason"] = "undo unavailable: " + gap
            else:
                entry["undo"] = {"kind": undo["kind"], "operation": undo["operation"], "arguments": arguments}
            plan.append(entry)
    return plan
`;
