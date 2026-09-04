# Reviewed weekly application

The application bundle is bound to the reviewed plan SHA-256. Organization
policy, title prefix, account identity, approval route, and provider-specific
read/write mechanics belong to the private provider.

Before the first external write:

1. reacquire the full normalized week snapshot;
2. replay the plan at the original planning instant;
3. require an identical plan SHA, item count, total, title, target state, and
   reuse/create decision;
4. resolve exactly one `weekly-expense-application-sink/v1` provider;
5. inspect its private stop conditions and earliest mutating step; and
6. obtain action-time confirmation for the destination account and exact
   operation.

For `reuse`, the provider may update only the approved draft key. For `create`,
it may create at most one application after confirmation. It selects the exact
approved expense keys, sets the exact approved title, and leaves the application
as a draft or submits it according to `targetState`. It must not modify expense
content, attachments, or unrelated applications.

After each write, reread the application and its full paginated transaction
membership. A response timeout or navigation failure is not permission to
create, save, or submit again. First determine whether the intended state was
already reached; otherwise return `uncertain` with the next human action.

For a draft result, verify it remains editable and unsubmitted. For a submitted
result, verify it has left draft state and entered the configured approval
workflow or an approved terminal state. In both cases verify the exact title,
exact expense-key set, item count, and total JPY.
