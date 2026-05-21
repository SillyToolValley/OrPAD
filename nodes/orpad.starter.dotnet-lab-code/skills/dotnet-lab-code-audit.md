# .NET Lab Code Audit

Use this skill when a pipeline repairs C#/.NET lab code, course examples, README-to-Program.cs alignment, or runnable teaching material.

Acceptance criteria:

- Each changed lab has explicit evidence linking README instructions, expected observations, and actual C# behavior.
- Program.cs, project, or solution changes are validated with dotnet build/run where practical.
- Candidates that rely on runtime behavior include code files in targetFiles or explain why no code change is needed.

Candidate target policy:

- When a finding depends on actual lab behavior, include the relevant Program.cs, .csproj, or .sln file in candidate targetFiles.
- Use README or slide targetFiles alone only when the code already matches the intended behavior and the content is stale.
- Record per-lab no-code-change evidence instead of silently treating C# files as read-only context.
