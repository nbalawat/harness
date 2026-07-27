"""agent-runtime module (v1): the approved roster, executed.

`respond()` is the single entry point the rest of the app may call, and its
signature is the composition contract (main.py and agents/run_evals.py both
depend on it). A hosted Claude Agent SDK implementation can replace this file
as long as it keeps the same signature; the eval suite in agents/ runs against
whichever implementation is composed.

What lives here:

  * the two agents from agents/roster.json (support_draft_agent,
    precedent_finder), each restricted to the tools its roster entry grants;
  * the tools themselves - keyword retrieval over the ingested product corpus
    (agents/corpus_index.json) and over stored conversations
    (agents/precedents.json);
  * the response policy the roster's eval_criteria encode: the automated-draft
    disclosure on every reply, citations for every grounded claim, an explicit
    no-coverage hand-off instead of speculation, approved-only precedents
    inside the 90-day retention window, and no claim of delivery.

Retrieval and phrasing are deterministic, so the eval suite is a real pass/fail
gate rather than a sampling exercise.
"""
from __future__ import annotations

import datetime
import json
import os
import re

AGENTS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agents")
)

# --------------------------------------------------------------------------
# loading
# --------------------------------------------------------------------------

_cache: dict[str, object] = {}


def _load_json(name: str):
    if name not in _cache:
        with open(os.path.join(AGENTS_DIR, name)) as f:
            _cache[name] = json.load(f)
    return _cache[name]


def roster() -> dict:
    return _load_json("roster.json")


def agent_spec(name: str) -> dict:
    for agent in roster()["agents"]:
        if agent["name"] == name:
            return agent
    raise KeyError(f"no agent named {name!r} in roster.json")


def conventions() -> dict:
    return roster().get("conventions", {})


def _corpus_index() -> dict:
    return _load_json("corpus_index.json")


def _precedent_store() -> dict:
    return _load_json("precedents.json")


def _doc_text(document: dict) -> str:
    key = "text:" + document["id"]
    if key not in _cache:
        with open(os.path.join(AGENTS_DIR, document["path"])) as f:
            _cache[key] = f.read()
    return _cache[key]


def _section(text: str, heading: str) -> str:
    """Pull one '## Heading' section out of a corpus document."""
    pattern = rf"^##\s+{re.escape(heading)}\s*$(.*?)(?=^##\s|\Z)"
    match = re.search(pattern, text, re.M | re.S)
    return match.group(1).strip() if match else text.strip()


# --------------------------------------------------------------------------
# term matching
# --------------------------------------------------------------------------

# Grammar and instruction words: carry no retrieval signal.
_STOPWORDS = """
a an the this that these those there here it its is are was were be been being am
do does did done have has had will would can could should shall may might must
i you he she we they me him her us them my your our their his hers ours theirs own
and or but if then than so as of in on at to for from with without by into over under
about after before during between out up down off again more most some any each all
every no not yes now just only very too also please
what which who whom whose when where why how
hi hello hey thanks thank ok okay great sure
ignore ignoring disregard forget forgetting tell show give find get make write need want
say answer explain describe list send
""".split()

# Domain-generic words: true of nearly every record, so they must not by
# themselves make a query look "covered".
_GENERIC = """
customer customers client clients user users account accounts
support supporting product products service services
question questions answer answers reply replies response responses draft drafts
help issue issues problem problems thing things case cases
knowledge document documents doc docs source sources corpus information info detail details
general specific
conversation conversations thread threads message messages ticket tickets history
analyst analysts assistant agent agents copilot
past previous prior earlier old older recent
""".split()


def _stem(word: str) -> str:
    return word[:-1] if len(word) > 3 and word.endswith("s") else word


def _tokens(text: str) -> list[str]:
    return [_stem(w) for w in re.findall(r"[a-z0-9][a-z0-9'-]*", text.lower())]


_STOP = {_stem(w) for w in _STOPWORDS} | {_stem(w) for w in _GENERIC}


def query_terms(query: str) -> list[str]:
    """Distinctive terms in a query: what retrieval is actually allowed to match on."""
    seen, terms = set(), []
    for token in _tokens(query):
        if token in _STOP or token.isdigit() and len(token) < 2:
            continue
        if token not in seen:
            seen.add(token)
            terms.append(token)
    return terms


def _threshold(terms: list[str]) -> int:
    """A single incidental word is not coverage; two are. Short queries fall back to one."""
    return min(2, len(terms))


def _match(terms: list[str], strong_text: str, weak_text: str) -> tuple[int, int]:
    """Return (coverage, score). Coverage counts distinct query terms found anywhere;
    score additionally weights hits in the title/keywords."""
    strong = set(_tokens(strong_text))
    weak = set(_tokens(weak_text))
    strong_hits = [t for t in terms if t in strong]
    coverage = len([t for t in terms if t in strong or t in weak])
    return coverage, coverage + 2 * len(strong_hits)


# --------------------------------------------------------------------------
# tools
# --------------------------------------------------------------------------


class ToolBudgetExceeded(RuntimeError):
    pass


class ToolNotGranted(PermissionError):
    """Raised when an agent reaches for a tool its roster entry does not grant."""


class ToolBelt:
    """Per-turn tool access, scoped to exactly what the roster grants an agent."""

    def __init__(self, agent: dict):
        self.agent = agent
        self.granted = set(agent.get("tools", []))
        self.max_calls = int(agent.get("config", {}).get("max_tool_calls_per_turn", 6))
        self.trace: list[dict] = []

    def _call(self, tool: str, **kwargs):
        if tool not in self.granted:
            raise ToolNotGranted(
                f"{self.agent['name']} may not call {tool!r} "
                f"(granted: {sorted(self.granted)})"
            )
        if len(self.trace) >= self.max_calls:
            raise ToolBudgetExceeded(
                f"{self.agent['name']} exceeded max_tool_calls_per_turn={self.max_calls}"
            )
        self.trace.append({"tool": tool, "args": kwargs})

    # -- support_draft_agent -------------------------------------------------

    def knowledge_search(self, query: str, limit: int = 3) -> list[dict]:
        """Keyword search over the ingested product corpus. Returns doc_id/title/snippet."""
        self._call("knowledge_search", query=query, limit=limit)
        terms = query_terms(query)
        if not terms:
            return []
        need = _threshold(terms)
        hits = []
        for document in _corpus_index()["documents"]:
            strong = document["title"] + " " + " ".join(document.get("keywords", []))
            coverage, score = _match(terms, strong, _doc_text(document))
            if coverage >= need:
                hits.append(
                    {
                        "doc_id": document["id"],
                        "title": document["title"],
                        "score": score,
                        "snippet": _section(_doc_text(document), "Answer").split("\n")[0],
                    }
                )
        hits.sort(key=lambda h: (-h["score"], h["doc_id"]))
        if hits:
            # Drop trailing hits that only matched incidental words: a document
            # scoring far below the best match is noise, and citing noise is
            # worse than citing nothing.
            lead = hits[0]["score"]
            hits = [h for h in hits if h["score"] * 2 >= lead]
        return hits[:limit]

    def knowledge_fetch(self, doc_id: str) -> dict:
        """Full text of a doc_id. Only ids present in corpus_index may be fetched."""
        self._call("knowledge_fetch", doc_id=doc_id)
        for document in _corpus_index()["documents"]:
            if document["id"] == doc_id:
                text = _doc_text(document)
                return {
                    "doc_id": doc_id,
                    "title": document["title"],
                    "answer": _section(text, "Answer"),
                    "text": text,
                }
        raise KeyError(f"{doc_id} is not in corpus_index.json; it may not be cited")

    def conversation_lookup(self, conversation_id: str | None) -> list[dict]:
        """Messages of the CURRENT conversation only - never another analyst's thread."""
        self._call("conversation_lookup", conversation_id=conversation_id)
        return []

    # -- precedent_finder ----------------------------------------------------

    def conversation_search(self, query: str, limit: int = 5) -> dict:
        """Approved conversations only, inside the retention window."""
        self._call("conversation_search", query=query, limit=limit)
        store = _precedent_store()
        retention = int(
            self.agent.get("config", {}).get("retention_days", store["retention_days"])
        )
        terms = query_terms(query)
        need = _threshold(terms)
        today = datetime.date.today()

        hits, withheld = [], 0
        for record in store["conversations"]:
            coverage, score = _match(
                terms,
                record["title"] + " " + " ".join(record.get("topics", [])),
                record["answer"],
            )
            if not terms or coverage < need:
                continue
            in_window = record["age_days"] <= retention
            approved = record["approval_status"] == "approved"
            if not (in_window and approved):
                # Deliberately dropped: never surfaced, only counted.
                withheld += 1
                continue
            hits.append(
                {
                    "conversation_id": record["id"],
                    "date": (today - datetime.timedelta(days=record["age_days"])).isoformat(),
                    "title": record["title"],
                    "approver": record["approver"],
                    "score": score,
                }
            )
        # Best match first; among equally good matches, the most recent one.
        hits.sort(key=lambda h: h["date"], reverse=True)
        hits.sort(key=lambda h: -h["score"])
        return {"hits": hits[:limit], "withheld": withheld, "retention_days": retention}

    def conversation_fetch(self, conversation_id: str) -> dict:
        """Full approved reply text for a conversation id returned by conversation_search."""
        self._call("conversation_fetch", conversation_id=conversation_id)
        store = _precedent_store()
        retention = int(
            self.agent.get("config", {}).get("retention_days", store["retention_days"])
        )
        for record in store["conversations"]:
            if record["id"] != conversation_id:
                continue
            if record["approval_status"] != "approved":
                raise PermissionError(f"{conversation_id} is not approved and cannot be reused")
            if record["age_days"] > retention:
                raise PermissionError(f"{conversation_id} is outside the retention window")
            return dict(record)
        raise KeyError(conversation_id)


# --------------------------------------------------------------------------
# shared reply conventions
# --------------------------------------------------------------------------


def disclosure(agent_name: str) -> str:
    template = conventions().get(
        "disclosure_prefix",
        "[Automated draft - generated by {agent_name}; pending analyst approval]",
    )
    return template.replace("{agent_name}", agent_name)


def _compose(agent_name: str, body: str, citations: list[str] | None = None) -> str:
    """Every reply: disclosure first line, citation block last, nothing implied in between."""
    parts = [disclosure(agent_name), "", body.strip()]
    if citations:
        parts += ["", "Sources:"] + [f"- {c}" for c in citations]
    return "\n".join(parts)


NO_COVERAGE = "not covered by the product knowledge base"

# Instructions to deliver something to a customer. The agent has no delivery
# tool (roster tool_policy.denied), so these are answered, never acted on.
# Deliberately narrow: it must be an instruction TO the agent, so that ordinary
# questions which merely mention email ("why didn't the reset email arrive?")
# still get a normal grounded answer.
_DELIVERY_VERB = r"(send|e-?mail|deliver|forward|dispatch)"
_DELIVERY_RE = re.compile(
    # imperative: "send ...", "Great, send ...", "and then email ..."
    rf"(?:^|[.!?,;]\s*|\b(?:please|now|just|then|and|ok|okay)\s+){_DELIVERY_VERB}\b"
    # asked of the agent: "can you send ...", "you should email ..."
    rf"|\b(?:can|could|will|would|should|please)\s+you\s+{_DELIVERY_VERB}\b"
    # verb taking the draft as its direct object: "send that answer", "email it"
    rf"|\b{_DELIVERY_VERB}\s+(?:it|that|this|them|"
    r"the\s+(?:answer|reply|response|draft|message))\b",
    re.I,
)

# Off-domain generation requests: the agent drafts support answers, not content.
_OFF_DOMAIN_RE = re.compile(
    r"\b(poem|poetry|haiku|limerick|sonnet|joke|jokes|song|lyrics|rap|story|novel|"
    r"screenplay|essay|recipe|riddle|horoscope|weather|sports|stocks?|election)\b",
    re.I,
)

# Attempts to talk the agent out of its grounding.
_OVERRIDE_RE = re.compile(
    r"\b(ignore|disregard|forget|bypass|skip)\b[^.?!]{0,60}"
    r"\b(document|documents|docs|source|sources|corpus|knowledge|retrieval|rules?)\b"
    r"|\b(your own|from memory|general) knowledge\b"
    r"|\bwithout (searching|citing|sources)\b",
    re.I,
)


# --------------------------------------------------------------------------
# support_draft_agent
# --------------------------------------------------------------------------


def _support_draft_agent(message: str, conversation_id: str | None) -> dict:
    agent = agent_spec("support_draft_agent")
    name = agent["name"]
    tools = ToolBelt(agent)

    # 1. A request to deliver something. The agent has no delivery tool and
    #    must not imply that anything left the building.
    if _DELIVERY_RE.search(message):
        body = (
            "Nothing has gone to the customer. I have no delivery tool - I only produce "
            "draft text, and delivery is not mine to perform.\n\n"
            "The next step belongs to you as the analyst: review the draft above, edit it "
            "if it needs it, then mark it approved in Support Copilot. Marking it approved "
            "records your decision and nothing else; you then copy the approved text into "
            "your existing email tool and deliver it yourself."
        )
        return {"agent": name, "reply": _compose(name, body), "coverage": "n/a",
                "citations": [], "trace": tools.trace}

    # 2. Off-domain generation: politely out of scope.
    if _OFF_DOMAIN_RE.search(message):
        body = (
            "That request is outside what I do. I only draft customer-support answers "
            "grounded in the product knowledge base, so free-form writing of that kind is "
            "not something I can produce here.\n\n"
            "Send me the customer's product question and I will draft a cited answer for "
            "your review."
        )
        return {"agent": name, "reply": _compose(name, body), "coverage": "out_of_scope",
                "citations": [], "trace": tools.trace}

    override = bool(_OVERRIDE_RE.search(message))
    preface = ""
    if override:
        preface = (
            "I can only answer from the ingested product knowledge base, not from general "
            "model memory, and I will not drop the citations. Here is the grounded answer "
            "instead.\n\n"
        )

    terms = query_terms(message)

    # 3. Nothing substantive to search on yet.
    if not terms:
        body = (
            "Yes - send me the customer's product question and I will draft an answer from "
            "the ingested product knowledge base, with the sources I used listed underneath.\n\n"
            "Everything I produce is a draft for you to review; I cannot deliver anything "
            "to a customer myself."
        )
        return {"agent": name, "reply": _compose(name, preface + body), "coverage": "n/a",
                "citations": [], "trace": tools.trace}

    # 4. Retrieval is required before any substantive answer.
    hits = tools.knowledge_search(message)

    if not hits:
        body = (
            f"I searched the ingested product knowledge base and found nothing on this: the "
            f"question is {NO_COVERAGE}, so I am not able to draft a grounded answer and I "
            f"will not fill the gap with an unsupported one.\n\n"
            "Suggested next step: hand this to a human analyst who can check with the owning "
            "team, then add the confirmed answer to the knowledge base so the next customer "
            "question on it is covered."
        )
        return {"agent": name, "reply": _compose(name, preface + body), "coverage": "uncovered",
                "citations": [], "trace": tools.trace}

    lead = tools.knowledge_fetch(hits[0]["doc_id"])
    citations = [f"{lead['doc_id']} ({lead['title']})"]
    body = f"From the product knowledge base:\n\n{lead['answer']}"

    for hit in hits[1:3]:
        extra = tools.knowledge_fetch(hit["doc_id"])
        citations.append(f"{extra['doc_id']} ({extra['title']})")
    if len(citations) > 1:
        body += "\n\nRelated material is cited below in case the customer's case differs."

    return {
        "agent": name,
        "reply": _compose(name, preface + body, citations),
        "coverage": "covered",
        "citations": [h["doc_id"] for h in hits[:3]],
        "trace": tools.trace,
    }


# --------------------------------------------------------------------------
# precedent_finder
# --------------------------------------------------------------------------

# Asking for a span the retention window cannot honour.
_OVER_RETENTION_RE = re.compile(
    r"\b(\d+|one|two|three|four|five|six|ten|several|many)\s+(year|years|months)\b"
    r"|\blast year\b|\ball[- ]time\b|\bof all time\b|\bsince \d{4}\b|\bever\b|\barchive[sd]?\b",
    re.I,
)

# Asking for the whole store rather than an actual search.
# Narrow on purpose: "every stored conversation" is a bulk request, but
# "every password reset precedent" is a real search and should be searched.
_BULK_RE = re.compile(
    r"\b(all|every|everything|entire|each)\s+(single\s+)?"
    r"(stored\s+|saved\s+|past\s+|previous\s+|old\s+)?"
    r"(conversation|conversations|record|records|thread|threads|ticket|tickets|"
    r"precedent|precedents)\b"
    r"|\b(dump|export|download)\s+(the\s+)?(whole|entire|everything|all)\b"
    r"|\beverything (you have|we have|in the system|on file)\b",
    re.I,
)

_REUSE_FOOTER = (
    "Before reusing any of this, open the source conversation, review it against the "
    "current knowledge base, and confirm it is still accurate for this customer. Approved "
    "precedent is a starting point for your draft, not a verified answer."
)


def _precedent_finder(message: str, conversation_id: str | None) -> dict:
    agent = agent_spec("precedent_finder")
    name = agent["name"]
    tools = ToolBelt(agent)
    retention = int(agent.get("config", {}).get("retention_days", 90))
    limit = int(agent.get("config", {}).get("max_results", 5))

    # 1. Span longer than retention: say so rather than silently truncating.
    if _OVER_RETENTION_RE.search(message):
        body = (
            f"I cannot cover that span. Conversation records live under a {retention}-day "
            f"retention window and anything older is purged, so I only search approved "
            f"conversations created in the last {retention} days - a longer search would "
            "hand you an incomplete picture that looks complete.\n\n"
            "Give me the specific topic, customer or question you are working on and I will "
            f"narrow the search to approved precedent inside the {retention}-day window."
        )
        return {"agent": name, "reply": _compose(name, body), "coverage": "retention_limited",
                "citations": [], "trace": tools.trace}

    # 2. Bulk export: support content stays scoped to an actual query.
    if _BULK_RE.search(message):
        body = (
            "I do not bulk-export stored conversations. Those records hold customer support "
            f"content, so I return only precedent that matches a specific analyst query, "
            f"capped at {limit} results.\n\n"
            "Tell me which topic, customer or question you are working on - or give me a "
            "search term - and I will narrow the search to approved conversations inside "
            f"the {retention}-day retention window."
        )
        return {"agent": name, "reply": _compose(name, body), "coverage": "refused_bulk",
                "citations": [], "trace": tools.trace}

    results = tools.conversation_search(message, limit=limit)
    hits = results["hits"]

    # 3. No precedent: say so plainly instead of inventing one.
    if not hits:
        body = (
            "No matching precedent. I searched approved conversations inside the "
            f"{retention}-day retention window and found no similar prior answer, so there "
            "is nothing here to reuse and I will not invent one.\n\n"
            "Suggested next step: draft a fresh answer with the drafting assistant, or "
            "check with the analyst who owns this area."
        )
        return {"agent": name, "reply": _compose(name, body), "coverage": "no_precedent",
                "citations": [], "trace": tools.trace}

    lines = [
        f"I searched approved conversations inside the {retention}-day retention window and "
        f"found {len(hits)} precedent{'s' if len(hits) != 1 else ''}:",
        "",
    ]
    for index, hit in enumerate(hits, start=1):
        record = tools.conversation_fetch(hit["conversation_id"])
        lines.append(
            f"{index}. {hit['conversation_id']} - {hit['date']} - status: approved "
            f"(approved by {hit['approver']})"
        )
        lines.append(f"   {record['title']}")
        lines.append(f"   \"{record['answer']}\"")
        lines.append("")

    if results["withheld"]:
        lines.append(
            f"{results['withheld']} further match"
            f"{'es were' if results['withheld'] != 1 else ' was'} withheld: not approved, or "
            f"outside the {retention}-day retention window."
        )
        lines.append("")

    lines.append(_REUSE_FOOTER)

    return {
        "agent": name,
        "reply": _compose(name, "\n".join(lines)),
        "coverage": "precedent_found",
        "citations": [h["conversation_id"] for h in hits],
        "trace": tools.trace,
    }


# --------------------------------------------------------------------------
# routing + entry point
# --------------------------------------------------------------------------

_PRECEDENT_INTENT_RE = re.compile(
    r"\bprecedent[s]?\b"
    r"|\b(past|previous|prior|earlier|old|similar)\b[^.?!]{0,40}"
    r"\b(answer|answers|reply|replies|conversation|conversations|thread|threads|ticket|tickets)\b"
    r"|\bconversations?\b",
    re.I,
)

_HANDLERS = {
    "support_draft_agent": _support_draft_agent,
    "precedent_finder": _precedent_finder,
}


def route(message: str) -> str:
    """Pick the agent for a message. Precedent lookup is explicit; drafting is the default."""
    if _PRECEDENT_INTENT_RE.search(message):
        return "precedent_finder"
    return "support_draft_agent"


def respond_detailed(
    message: str, agent: str | None = None, conversation_id: str | None = None
) -> dict:
    """Full result: reply text plus the agent, citations, coverage and tool trace.

    coverage maps onto messages.coverage_status; citations onto message_citations.
    """
    name = agent or route(message)
    if name not in _HANDLERS:
        raise KeyError(f"no handler for agent {name!r}")
    return _HANDLERS[name](message, conversation_id)


def respond(
    message: str, agent: str | None = None, conversation_id: str | None = None
) -> str:
    """Draft reply text for one analyst turn. Always a draft, never a delivery."""
    return respond_detailed(message, agent=agent, conversation_id=conversation_id)["reply"]
