import { expect, test } from "bun:test";
import { closed, comparison, criticRecord, directionOf, invest, ledger, review } from "./rsi-judges.ts";

const scripted = (...replies: string[]) => { const prompts: string[] = []; return { prompts, ask: async (p: string) => (prompts.push(p), replies.shift() ?? "") }; };

test("a direction is the changed non-test files, and it closes after losing twice in a row", () => {
  expect(directionOf(["src/tools.ts", "src/harness.test.ts", "", "src/agent.ts"])).toBe("src/agent.ts, src/tools.ts");
  expect(directionOf(["src/harness.test.ts"])).toBe("(tests only)");
  const gens = [
    { gen: 1, phase: "done", direction: "src/tools.ts", accepted: true, spent: 10 },
    { gen: 2, phase: "done", direction: "src/agent.ts", accepted: false, spent: 5 },
    { gen: 3, phase: "done", direction: "src/tools.ts", accepted: false, spent: 7 },
    { gen: 4, phase: "evaluate", direction: "src/tools.ts" },
  ];
  expect(ledger(gens)["src/tools.ts"]).toMatchObject({ generations: [1, 3], spent: 17, wins: 1, losses: 1, streak: 1 });
  expect(closed(ledger(gens))).toEqual([]);
  expect(closed(ledger([...gens.slice(0, 3), { gen: 5, phase: "done", direction: "src/tools.ts", accepted: false }]))).toEqual(["src/tools.ts"]);
});

test("the investor's grant is clamped to the budget, and an unreadable reply still funds a generation", async () => {
  const input = { history: "h", incumbent: "{}", ledger: ledger([{ gen: 1, phase: "done", direction: "src/tools.ts", accepted: false }, { gen: 2, phase: "done", direction: "src/tools.ts", accepted: false }]), maxCalls: 150 };
  const s = scripted('ok {"direction": "trim tool output", "rationale": "peaks come from file_read", "expected": "-10% peak", "calls": 900}');
  expect(await invest(s.ask, input)).toEqual({ direction: "trim tool output", rationale: "peaks come from file_read", expected: "-10% peak", calls: 150 });
  expect(s.prompts[0]).toContain("Closed: src/tools.ts");
  expect((await invest(scripted("no").ask, input)).calls).toBe(150);
  expect((await invest(scripted('{"calls": 1}').ask, input)).calls).toBe(20);
});

test("only an upheld objection can veto, and an unreadable ruling keeps the mechanical decision", async () => {
  const input = { diff: "d", note: "n", result: "score 0.6 -> 0.7", comparison: comparison({ a: 1, b: 0 }, { a: 1, b: 1 }), record: { upheld: 0, overruled: 0 } };
  expect(input.comparison).toStartWith("1 questions improved, 0 got worse, 1 unchanged");
  const objection = '{"objections": [{"claim": "one question flipped", "evidence": "b"}]}';
  const vetoed = await review(scripted(objection, '{"rulings": [{"upheld": true, "ruling": "noise"}], "veto": true, "reason": "noise"}').ask, input);
  expect(vetoed).toMatchObject({ veto: true, objections: [{ upheld: true, ruling: "noise" }] });
  expect((await review(scripted(objection, '{"rulings": [{"upheld": false}], "veto": true, "reason": "x"}').ask, input)).veto).toBe(false);
  expect((await review(scripted(objection, "???").ask, input))).toMatchObject({ veto: false, reason: "the evaluator's reply was not JSON" });
  expect((await review(scripted('{"objections": []}').ask, input))).toMatchObject({ veto: false, reason: "no objections" });
  expect(criticRecord([vetoed, undefined, { objections: [{ claim: "c", evidence: "e", upheld: false }], veto: false, reason: "" }])).toEqual({ upheld: 1, overruled: 1 });
});
