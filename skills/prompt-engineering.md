# Prompt Engineering Guide — Claude Opus 4.6

A practical guide for writing effective prompts for Claude Opus 4.6 and similar frontier models. Based on real-world discoveries, not theory.

## Core Principle

Opus 4.6 is a reasoning model. It responds better to explanations than commands. Treat it like briefing a smart colleague, not programming a machine.

---

## 1. Drop the Urgency Markers

Older models needed emphasis to follow instructions. Opus 4.6 doesn't — and urgency markers actively hurt.

**The problem:** ALL-CAPS words like CRITICAL, MUST, NEVER, ALWAYS cause overtriggering. The model becomes hypervigilant and starts seeing edge cases everywhere, applying rules too aggressively.

**What works:** State the rule plainly. If it's important, explain why it matters — the model will weight it appropriately based on understanding, not typographic shouting.

```
# Instead of:
"You MUST ALWAYS validate input. NEVER skip validation. This is CRITICAL."

# Write:
"Validate all input before processing. Unvalidated input can cause SQL injection 
and data corruption, which are hard to detect after the fact."
```

The model now understands the stakes and applies validation proportionally — strict for database queries, lighter for display-only fields.

---

## 2. Explain Why, Not Just What

Rules without reasoning produce brittle behavior. The model follows the letter but misses the spirit, and can't generalize to novel situations.

**The problem:** "Don't use markdown tables in WhatsApp" is a rule. The model follows it but doesn't know what to do on a new platform.

**What works:** Include the reasoning. The model extrapolates correctly to situations you didn't anticipate.

```
# Instead of:
"Don't use markdown tables in WhatsApp messages."

# Write:
"WhatsApp doesn't render markdown tables — they appear as broken text. 
Use bullet lists for structured data on platforms without table support."
```

Now if the model encounters a new platform, it checks whether tables render rather than blindly following a platform-specific rule.

---

## 3. Show Only Desired Behavior

This is counterintuitive. You'd think showing "don't do this / do this" pairs would be clear. With Opus 4.6, anti-patterns contaminate.

**The problem:** The model processes anti-patterns as examples. Even prefixed with "bad" or "wrong," the pattern enters the model's working context and sometimes gets reproduced, especially under pressure (long conversations, complex tasks).

**What works:** Only demonstrate the correct approach. If you need to explain what to avoid, describe it abstractly without showing the actual pattern.

```
# Instead of:
"Bad: 'Great question! I'd be happy to help with that!'
Good: Just answer directly."

# Write:
"Answer directly without preamble. Start with the substance of the response."

# Example:
User: "What's the capital of France?"
Assistant: "Paris. It's been the capital since the 10th century..."
```

---

## 4. Remove "If in Doubt" Fallbacks

Default-to-action instructions cause overuse. The model interprets uncertainty broadly and triggers the fallback constantly.

**The problem:** "If you're unsure whether to use the search tool, use it anyway" causes the model to search on nearly every query, even ones it can answer from training data.

**What works:** Specify positive triggers — when the tool should be used, not when it might be used.

```
# Instead of:
"If in doubt about whether to search, search anyway."

# Write:
"Search when the user asks about current events, prices, availability, 
or anything that changes frequently. For established facts, general knowledge,
and code patterns, respond from your training."
```

This gives the model a decision framework instead of a fear-based default.

---

## 5. Match Prompt Format to Output Format

The model mirrors the structural patterns it sees. If your prompt uses bullet lists, the model tends toward bullet lists. If your prompt uses dense paragraphs, responses trend dense.

**The insight:** This isn't just about asking for a format — the prompt itself acts as a template. The model picks up on heading styles, list patterns, sentence length, and information density.

```
# If you want concise bullet-point responses:
Write your prompt in concise bullets.

# If you want detailed narrative:
Write your prompt as flowing paragraphs with context and nuance, 
and the model will mirror that depth in its response.

# If you want structured reports:
Structure your prompt like a report with clear sections and headers.
```

---

## 6. Use Soft Boundaries Over Hard Rules

Hard rules create adversarial dynamics where the model tries to comply literally but misses intent. Soft boundaries with context produce better judgment.

**The problem:** "Never respond to messages that don't mention your name" causes the model to ignore emergencies, time-sensitive information, and obvious direct communication.

**What works:** Describe the intent and trust the model's judgment.

```
# Instead of:
"Never respond unless directly addressed by name."

# Write:
"You're in a group chat. Respond when called by name or when there's a clear 
task directed at you. Stay quiet during casual banter between others — 
contributing to every message would be disruptive."
```

---

## 7. Context Windows and Prompt Position

Where information appears in the prompt matters. Opus 4.6 handles long contexts well but still has attention patterns.

**Key patterns:**
- System prompt instructions have the strongest influence early in conversation
- Instructions at the very end of a long context get slightly more attention than middle sections
- Repeated instructions across the prompt reinforce better than one emphatic statement
- Structured prompts (with headers and sections) are parsed more reliably than wall-of-text

```
# Structure for complex system prompts:
1. Identity and role (who are you)
2. Core behaviors (how to act)  
3. Specific rules (what to do in situations)
4. Context (what you know about the user/environment)
5. Brief recap of most critical behaviors
```

---

## 8. Tool Descriptions Shape Usage

How you describe tools determines when the model uses them. Vague descriptions cause overuse; overly specific ones cause underuse.

**What works:** Describe the tool's purpose and the situations it serves. Include what it returns so the model knows what to expect.

```
# Instead of:
"web_search: Search the web for information."

# Write:
"web_search: Query Brave Search for current information. Returns titles, URLs, 
and snippets. Use for time-sensitive data (news, prices, events, weather) 
and verifying claims about recent developments."
```

---

## 9. Persona and Tone

Opus 4.6 is remarkably good at maintaining persona — but only if the persona is described through behavior, not labels.

**The problem:** "Be professional and friendly" means nothing concrete. Every response becomes a bland middle ground.

**What works:** Describe specific communication patterns the persona uses.

```
# Instead of:
"Be helpful and professional."

# Write:
"Be direct. Skip filler phrases. If you don't know something, say so and 
offer to find out. Have opinions when asked — 'it depends' without elaboration 
isn't helpful. Match the user's energy: brief questions get brief answers, 
detailed questions get thorough ones."
```

---

## 10. Multi-Step Task Decomposition

For complex tasks, the model performs better when you describe the workflow as a sequence of decisions rather than a monolithic instruction.

**What works:** Break complex behavior into a decision tree the model can follow.

```
# Instead of:
"Analyze the code and produce a security report with findings."

# Write:
"Security review workflow:
1. Read each source file
2. For each file, note: authentication patterns, input handling, 
   data exposure, error handling
3. Cross-reference findings — does file A trust input from file B 
   without validation?
4. Rank findings by exploitability (can an external attacker trigger this?)
5. Format as numbered findings with file:line references"
```

---

## Quick Reference

| Pattern | Why It Works |
|---------|-------------|
| Plain language over caps | Prevents overtriggering and hypervigilance |
| Explain the why | Model generalizes to novel situations |
| Positive examples only | Anti-patterns contaminate model behavior |
| Specific triggers over defaults | Prevents tool/behavior overuse |
| Format matching | Model mirrors structural patterns |
| Soft boundaries | Better judgment than rigid rules |
| End-position emphasis | Recency bias in long contexts |
| Behavioral personas | Concrete actions over abstract labels |
| Decision trees | Reliable complex task execution |

---

## Applying This Guide

When writing or reviewing prompts:
1. Read through the prompt looking for ALL-CAPS emphasis — rewrite as explanations
2. Check for anti-pattern examples — remove them, keep only desired behavior
3. Look for "if in doubt" / "when unsure" fallbacks — replace with positive triggers
4. Verify the prompt's formatting matches the desired output style
5. Test with edge cases — does the model apply rules proportionally or absolutely?

This guide itself follows its own principles. Notice: no urgency markers, explanations for every rule, only positive examples, structured format matching the kind of structured thinking it teaches.
