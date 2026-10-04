# Search Actuator Examples

Query-origin search. Transport pipelines (fetch / A2A) stay with network-actuator.

## web_search (offline stub)

```json
{ "op": "web_search", "params": { "query": "kyberion actuator contract", "top_k": 5 } }
```

Returns:

```json
{
  "provider": "unconfigured",
  "query": "kyberion actuator contract",
  "top_k": 5,
  "results": [],
  "hint": "configure service binding"
}
```

With an explicit provider binding, the provider value is echoed back in the
stub instead of `unconfirmed`/`unconfigured` default:

```json
{ "op": "web_search", "params": { "query": "kyberion", "provider": "example-provider" } }
```

## fetch_reader (bounded plain-text reader)

```json
{ "op": "fetch_reader", "params": { "url": "https://example.com/", "max_chars": 8000 } }
```

Only absolute `http:`/`https:` URLs are accepted. Responses are fetched with a
10s timeout and a 1MiB body cap, stripped of tags/scripts/styles, and truncated
to `max_chars` (default 8000). No secrets are attached to the request.
