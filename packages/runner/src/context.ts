import type { ProjectTypeDef } from "@harness/spec";
import type { Journal } from "./journal.js";

export interface RunContext {
  /** Absolute path to the run workspace (journal, attempts, artifacts). */
  workspace: string;
  /** Absolute path to the project-type package directory. */
  projectTypeDir: string;
  def: ProjectTypeDef;
  journal: Journal;
  /** Recorded gate answers: nodeId -> questionId -> answer. Certification replay uses this. */
  answers?: Record<string, Record<string, string>>;
  /** Run agent nodes via their `mock` command instead of the Agent SDK. */
  mockAgents: boolean;
  /** Whether we may prompt a human on stdin for unanswered gates. */
  interactive: boolean;
  /**
   * Auto-apply question defaults without showing them (unattended replay /
   * certification). When false, defaults are shown pre-filled for the human
   * to confirm or edit — in the terminal or the dashboard gate form.
   */
  acceptDefaults?: boolean;
}
