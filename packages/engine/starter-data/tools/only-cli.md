# Only CLI (oc)
What: a free MIT command-line tool (npm @only-cli/oc, v0.5.8) that turns a web page into a short numbered outline.
Use when: the agent must read docs or a web page to answer a question.
Don't use when: the page needs a login, the site blocks it, or it fails; then fall back to WebFetch.
Cost: free; about 450 tokens for a first view of a page. Round 1: 41% fewer tokens than WebFetch.
Install: npm install @only-cli/oc (needs Node 20+).
