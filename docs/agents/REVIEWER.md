# Reviewer Agent

The Reviewer agent performs QA, writes/runs tests, and approves or reopens completed tasks.

## Role Purpose

- Claim tasks in REVIEW status
- Review implemented code changes
- Run existing tests and write new unit tests
- Approve tasks (`moe.qa_approve` → DONE) or reject (`moe.qa_reject` → back to WORKING)

Never move a REVIEW task back to BACKLOG — BACKLOG is a human-triage column no
agent claims, so a rejected task sent there is stranded until a human
re-triages it. `moe.qa_reject` routes it to WORKING with structured
`rejectionDetails` the worker acts on directly.

## Status Transitions

```mermaid
graph LR
    R[REVIEW] -->|qa_approve| D[DONE]
    R -->|qa_reject| W[WORKING]
```

## MCP Tools Used

| Tool | Purpose |
|------|---------|
| `moe.claim_next_task` | Claim tasks with `statuses: ["REVIEW"]` |
| `moe.get_context` | Get task details and implementation plan |
| `moe.qa_approve` | Approve: REVIEW → DONE |
| `moe.qa_reject` | Reject: REVIEW → WORKING, with `rejectionDetails` |

## Workflow

```mermaid
sequenceDiagram
    participant RV as Reviewer
    participant M as Moe Daemon
    participant W as Worker

    RV->>M: moe.claim_next_task({statuses: ["REVIEW"]})
    M-->>RV: task + implementationPlan

    RV->>RV: Review code changes
    RV->>RV: Run existing tests
    RV->>RV: Write new unit tests

    alt All checks pass
        RV->>M: moe.qa_approve({taskId})
    else Issues found
        RV->>M: moe.qa_reject({taskId, reason, rejectionDetails})
        M-->>W: Task reopened (WORKING) with rejectionDetails
    end
```

## Review Checklist

### Code Review
- [ ] Code matches the implementation plan
- [ ] All Definition of Done criteria met
- [ ] No obvious bugs or logic errors
- [ ] Code follows project patterns/conventions
- [ ] No security vulnerabilities
- [ ] No hardcoded secrets or credentials

### Testing Requirements
- [ ] Existing tests still pass
- [ ] New unit tests cover the changes
- [ ] Edge cases are tested
- [ ] Error handling is tested

### Documentation
- [ ] Code is self-documenting or has comments
- [ ] Public APIs have documentation
- [ ] README updated if needed

## Unit Test Requirements

For each task, the reviewer should ensure:

1. **Coverage**: New code has corresponding unit tests
2. **Assertions**: Tests have meaningful assertions
3. **Edge cases**: Boundary conditions are tested
4. **Error paths**: Error handling is verified

Example test structure:
```kotlin
class UserServiceTest {
    @Test
    fun `createUser validates email format`() {
        // Arrange
        val service = UserService()

        // Act & Assert
        assertThrows<ValidationException> {
            service.createUser("invalid-email", "password")
        }
    }

    @Test
    fun `createUser saves valid user to database`() {
        // ...
    }
}
```

## Approve vs Reject

**Approve (`moe.qa_approve` → DONE)** when:
- All Definition of Done criteria are met
- Tests pass and cover the changes
- Code quality is acceptable

**Reject (`moe.qa_reject` → WORKING)** when:
- Definition of Done not fully met
- Tests fail or are missing
- Significant bugs found
- Security issues discovered

When rejecting, always provide structured details the worker can act on:

```typescript
moe.qa_reject({
  taskId: "task-abc123",
  reason: "Missing unit tests for error handling in UserService.createUser",
  rejectionDetails: {
    failedDodItems: ["Unit tests cover error paths"],
    issues: [{
      type: "test_failure",
      description: "createUser has no test for the invalid-email path",
      file: "src/services/UserService.ts",
      line: 42
    }]
  }
})
```

## Example Prompt

```
Role: reviewer. Always use Moe MCP tools. Start by claiming the next task for your role.

Call moe.claim_next_task {statuses:["REVIEW"]}. If hasNext is false, say: 'No tasks in review queue' and wait.

When you have a task:
1. Read the task description and Definition of Done
2. Review the implementation plan and changed files
3. Run existing tests: [project-specific test command]
4. Write unit tests if missing for new code
5. Check all DoD criteria are met

If all checks pass:
  - Call moe.qa_approve({taskId})

If issues found:
  - Call moe.qa_reject({taskId, reason: "<summary>", rejectionDetails: {failedDodItems: [...], issues: [...]}})
```

## Tips

- Be specific in rejection details - help the worker fix issues
- Focus on functionality first, style second
- Don't reopen for minor style issues - note them but approve
- Ensure tests are maintainable, not just present
- Check that the PR (if any) is ready to merge
- Verify no debugging code or console.logs left in
