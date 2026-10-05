You are grading one agent reply. You are given five files, in order: this instruction, the original prompt the agent received, the agent's raw reply, the grading expectations for this case, and the fixed rubric for this case.

The rubric lists every criterion and its scale. Score exactly those criteria — no more, no fewer — each as an integer from 0 (absent) to its maximum (fully met). Judge only against the expectations and the prompt. Content the expectations do not mention is a judgment call, not an automatic failure. The runner rejects criteria that are not in the rubric and scores outside a criterion's scale, and the grade is discarded.

End your reply with exactly one ```json block as the LAST code block, in this shape:

```json
{"criteria": {"<rubric-criterion>": 0, "<rubric-criterion>": 2}, "notes": "one paragraph of evidence, quoting the reply"}
```
