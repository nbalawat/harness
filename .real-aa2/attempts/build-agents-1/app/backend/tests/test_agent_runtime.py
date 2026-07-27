"""Runtime-level regression tests for the roster's guarantees.

agents/run_evals.py is the contractual gate (one case per roster eval_criterion).
These tests cover the machinery underneath it: tool scoping, the retention and
approval filters, and the guards that must not misfire on ordinary questions.
"""
import datetime
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import agent_runtime as rt  # noqa: E402


def test_roster_agents_are_wired():
    names = {a["name"] for a in rt.roster()["agents"]}
    assert names == set(rt._HANDLERS)


def test_every_reply_opens_with_the_disclosure():
    for agent in rt.roster()["agents"]:
        for case in agent["eval_cases"]:
            reply = rt.respond(case["input"], agent=agent["name"])
            assert reply.startswith(rt.disclosure(agent["name"]))


def test_agent_cannot_call_a_tool_it_was_not_granted():
    belt = rt.ToolBelt(rt.agent_spec("precedent_finder"))
    with pytest.raises(rt.ToolNotGranted):
        belt.knowledge_fetch("doc-password-reset")


def test_tool_budget_is_enforced():
    agent = dict(rt.agent_spec("support_draft_agent"))
    agent["config"] = dict(agent["config"], max_tool_calls_per_turn=1)
    belt = rt.ToolBelt(agent)
    belt.knowledge_search("password reset")
    with pytest.raises(rt.ToolBudgetExceeded):
        belt.knowledge_search("password reset")


def test_only_indexed_docs_can_be_fetched():
    belt = rt.ToolBelt(rt.agent_spec("support_draft_agent"))
    with pytest.raises(KeyError):
        belt.knowledge_fetch("doc-not-in-the-index")


def test_unapproved_and_expired_precedents_are_never_fetchable():
    belt = rt.ToolBelt(rt.agent_spec("precedent_finder"))
    for conversation_id in ("conv-2110", "conv-2044", "conv-1802"):
        with pytest.raises(PermissionError):
            belt.conversation_fetch(conversation_id)


def test_precedent_search_surfaces_only_approved_in_window_records():
    belt = rt.ToolBelt(rt.agent_spec("precedent_finder"))
    results = belt.conversation_search("password reset")
    returned = {h["conversation_id"] for h in results["hits"]}
    assert returned == {"conv-2098", "conv-2071"}
    assert results["withheld"] == 3


def test_precedent_dates_are_inside_the_retention_window():
    belt = rt.ToolBelt(rt.agent_spec("precedent_finder"))
    today = datetime.date.today()
    for hit in belt.conversation_search("password reset")["hits"]:
        age = (today - datetime.date.fromisoformat(hit["date"])).days
        assert 0 <= age <= 90


def test_delivery_guard_does_not_swallow_ordinary_questions():
    """A question that merely mentions email still gets a grounded answer."""
    result = rt.respond_detailed(
        "Why did the password reset email never arrive for the customer?"
    )
    assert result["coverage"] == "covered"
    assert result["citations"] == ["doc-password-reset"]


def test_delivery_instruction_is_refused():
    result = rt.respond_detailed("Can you email the draft to the customer?")
    assert result["trace"] == []  # refused before touching a tool
    assert "no delivery tool" in result["reply"]


def test_bulk_guard_does_not_swallow_a_real_search():
    assert rt.respond_detailed("List all conversations.")["coverage"] == "refused_bulk"
    assert (
        rt.respond_detailed("Find a past answer about every password reset precedent.")[
            "coverage"
        ]
        == "precedent_found"
    )


def test_uncovered_question_cites_nothing():
    result = rt.respond_detailed("What is our 2031 enterprise pricing roadmap?")
    assert result["coverage"] == "uncovered"
    assert result["citations"] == []
    assert rt.NO_COVERAGE in result["reply"]


def test_grounded_answer_is_copied_from_the_cited_document():
    result = rt.respond_detailed("How does a customer reset their password?")
    belt = rt.ToolBelt(rt.agent_spec("support_draft_agent"))
    source = belt.knowledge_fetch(result["citations"][0])["answer"]
    assert source in result["reply"]


def test_routing_defaults_to_drafting():
    assert rt.route("How does a customer reset their password?") == "support_draft_agent"
    assert rt.route("Find a past answer about password resets.") == "precedent_finder"
