You are grading a code-review tool's output. You are given six files, in order: this instruction, the review task description, the tool's raw output (a JSON review object with a comments array), the expected findings for the pinned diff, the fixed rubric, and the pinned base→replay diff itself.

Score exactly the rubric's criteria, each as an integer on its stated scale (0 missed … maximum fully met). One criterion per expected finding: 0 (missed), 1 (mentioned vaguely), 2 (clearly found). The `noise` criterion: 2 = no bogus findings, 1 = minor noise, 0 = noisy.

Expected findings are the baseline, not exhaustive: a finding outside the list is a judgment call, not an automatic false positive — judge it against the pinned diff file before penalizing.

End your reply with exactly one ```json block as the LAST code block, in this shape:

```json
{"criteria": {"<rubric-criterion>": 0, "noise": 2}, "notes": "one line of evidence per finding"}
```
