# Jev vs haiku: decision benchmark on real mail

Aggregate numbers only (no mail content, names or projects). 80 real emails, stratified (relevant with a task, relevant without a task, fyi, noise, the owner's sent mail), cleaned text capped near 6K tokens. Gold: sonnet at high effort, once per email; the owner's answers override the gold on 18 emails. Same seven questions for both models.

| question | n | pipeline acc | haiku acc | Jev acc | Jev acc at conf>=0.9 | Jev coverage at >=0.9 | Jev>=0.9 else haiku | Jev best threshold (noul) |
|---|---|---|---|---|---|---|---|---|
| kind | 80 | 70.0% | 66.3% | 61.3% | 80.6% | 38.8% | 66.3% | - |
| needs_task | 80 | 90.0% | 68.8% | 61.3% | 100.0% | 5.0% | 68.8% | p>=0.9: 75.0% |
| ours_vs_others | 80 | n/a | 73.8% | 52.5% | 80.0% | 6.3% | 76.3% | - |
| project | 80 | 61.3% | 98.8% | 97.5% | 97.4% | 96.3% | 97.5% | - |
| related | 192 | n/a | 98.4% | 94.3% | 100.0% | 42.2% | 98.4% | p>=0.5: 94.3% |
| fact_worthy | 80 | n/a | 76.3% | 73.8% | 100.0% | 2.5% | 76.3% | p>=0.6: 80.0% |
| deadline_mentioned | 80 | n/a | 97.5% | 96.3% | 100.0% | 80.0% | 98.8% | p>=0.7: 100.0% |

Noise gate (Jev says noise at conf>=0.9, haiku skipped): 4 of 80 emails (5.0%), precision 100.0%, recall of the gold noise 21.1% (19 gold-noise emails).

Email level (kind + needs_task + project all at conf>=0.9): coverage 0.0%, accuracy of those n/a (with related_task too: n/a); haiku on all emails: 57.5%.

Cost and latency per email: haiku $0.0007, 6679 ms; sonnet gold $0.0115; Jev 1774 input and 512 output tokens, 428 ms (priced by Workers AI credits, not measured in dollars here).

| stratum | n | Jev coverage at >=0.9 | accuracy of covered |
|---|---|---|---|
| relevant_task | 16 | 0.0% | n/a |
| relevant_notask | 16 | 0.0% | n/a |
| fyi | 16 | 0.0% | n/a |
| noise | 16 | 0.0% | n/a |
| sent | 16 | 0.0% | n/a |

## Production design (recommendation)

1. **Keep a small LLM (haiku) as the decision model**: it matches the gold better than Jev on kind, needs_task, ours_vs_others and fact_worthy (kind 66.3% vs 61.3%, needs_task 68.8% vs 61.3%, ours_vs_others 73.8% vs 52.5%, fact_worthy 76.3% vs 73.8%) and costs $0.0007 per email on cleaned text, 6679 ms.
2. **Jev as a first layer only where it is both confident and accurate**: project (accuracy 97.4% at conf>=0.9, answers 96.3% of the cases), related (accuracy 100.0% at conf>=0.9, answers 42.2% of the cases), deadline_mentioned (accuracy 100.0% at conf>=0.9, answers 80.0% of the cases); every other case is escalated to haiku. For kind, needs_task, ours_vs_others, fact_worthy Jev is below that bar (confidence >=0.9 covers only kind 38.8%, needs_task 5.0%, ours_vs_others 6.3%, fact_worthy 2.5%), so those always go to haiku.
3. **Noise gate**: Jev kind=noise at conf>=0.9 skips the LLM for 5.0% of this sample at 100.0% precision (recall of the gold noise 21.1%).
4. **Expected cost and error**: since needs_task/kind/fact must be answered by haiku for nearly every email, the LLM call is saved only for the noise gate (5.0%): about $0.0006 per email against $0.0007 (Jev adds ~1774 tokens in and ~512 out per call on Workers AI credits). Expected error on the core decisions stays that of haiku (42.5% on the combined kind + needs_task + project, against the gold corrected by the owner), the pipeline's own decisions agree with the gold at kind 70.0%, needs_task 90.0%.
5. The decisive cost in production is the size of the prompt and the number of gate retries, not the classification call: this benchmark uses ~708 characters of cleaned text per email.

Failures (no parsable answer): Jev 0, haiku 0, gold 0.
