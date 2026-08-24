//! Lane and edge assignment for the commit graph.
//!
//! Rust counterpart of `src/core/git-graph-layout.ts`. Pure: it takes a
//! topologically ordered commit list (newest first, as `git log` emits) and
//! decides which column each commit draws in and which lines connect it to its
//! parents. No git access, no I/O — which is what makes it directly testable
//! against hand-written histories.
//!
//! The algorithm maintains an array of *active lanes*. Each slot holds the
//! hash of the commit expected to appear next in that lane — a child waiting
//! for its parent. For each commit:
//!   1. Pick the leftmost lane reserving this commit's hash, else allocate one.
//!   2. Clear every reservation for this hash (several children can converge).
//!   3. Put the first parent in this commit's own lane when free, otherwise
//!      reuse the lane already reserving it.
//!   4. Give each additional parent an existing reserving lane, or a new one.
//!   5. Record the other lanes still alive, which draw as pass-through lines.
//!   6. Drop trailing empty lanes so the graph does not drift right forever.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphCommitInput {
    pub hash: String,
    pub parents: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitGraphEdgeKind {
    Straight,
    Branch,
    Merge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitGraphEdge {
    pub from_lane: usize,
    pub to_lane: usize,
    pub parent_hash: String,
    pub kind: GitGraphEdgeKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitGraphLayoutRow {
    pub hash: String,
    pub lane: usize,
    pub lane_count: usize,
    pub edges: Vec<GitGraphEdge>,
    /// Lanes other than this commit's that continue past this row — each one
    /// draws a vertical pass-through line.
    pub through_lanes: Vec<usize>,
}

pub fn assign_lanes(commits: &[GraphCommitInput]) -> Vec<GitGraphLayoutRow> {
    let mut rows: Vec<GitGraphLayoutRow> = Vec::new();
    let mut active: Vec<Option<String>> = Vec::new();

    for commit in commits {
        let lane = match position_of(&active, &commit.hash) {
            Some(index) => index,
            None => {
                let free = first_free_lane(&active);
                if free == active.len() {
                    active.push(None);
                }
                free
            }
        };

        // A commit can have several children waiting on it — they all converge
        // here, so every reservation for this hash is released at once.
        for slot in active.iter_mut() {
            if slot.as_deref() == Some(commit.hash.as_str()) {
                *slot = None;
            }
        }

        let mut edges: Vec<GitGraphEdge> = Vec::new();
        let mut parents = commit.parents.iter();

        if let Some(first_parent) = parents.next() {
            let parent_lane = match position_of(&active, first_parent) {
                Some(existing) => existing,
                None => {
                    active[lane] = Some(first_parent.clone());
                    lane
                }
            };
            edges.push(GitGraphEdge {
                from_lane: lane,
                to_lane: parent_lane,
                parent_hash: first_parent.clone(),
                kind: if parent_lane == lane {
                    GitGraphEdgeKind::Straight
                } else {
                    GitGraphEdgeKind::Merge
                },
            });
        }

        for parent in parents {
            let parent_lane = match position_of(&active, parent) {
                Some(existing) => existing,
                None => {
                    let free = first_free_lane(&active);
                    if free == active.len() {
                        active.push(None);
                    }
                    active[free] = Some(parent.clone());
                    free
                }
            };
            edges.push(GitGraphEdge {
                from_lane: lane,
                to_lane: parent_lane,
                parent_hash: parent.clone(),
                kind: if parent_lane == lane {
                    GitGraphEdgeKind::Straight
                } else {
                    GitGraphEdgeKind::Merge
                },
            });
        }

        let through_lanes: Vec<usize> = active
            .iter()
            .enumerate()
            .filter(|(index, slot)| *index != lane && slot.is_some())
            .map(|(index, _)| index)
            .collect();

        rows.push(GitGraphLayoutRow {
            hash: commit.hash.clone(),
            lane,
            lane_count: (lane + 1).max(active.len()),
            edges,
            through_lanes,
        });

        compact_trailing_empties(&mut active);
    }

    rows
}

fn position_of(active: &[Option<String>], hash: &str) -> Option<usize> {
    active.iter().position(|slot| slot.as_deref() == Some(hash))
}

fn first_free_lane(active: &[Option<String>]) -> usize {
    active
        .iter()
        .position(Option::is_none)
        .unwrap_or(active.len())
}

fn compact_trailing_empties(active: &mut Vec<Option<String>>) {
    while active.last().is_some_and(Option::is_none) {
        active.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(hash: &str, parents: &[&str]) -> GraphCommitInput {
        GraphCommitInput {
            hash: hash.to_string(),
            parents: parents.iter().map(|parent| parent.to_string()).collect(),
        }
    }

    #[test]
    fn a_linear_history_stays_in_one_lane() {
        let rows = assign_lanes(&[commit("c", &["b"]), commit("b", &["a"]), commit("a", &[])]);
        assert_eq!(
            rows.iter().map(|row| row.lane).collect::<Vec<_>>(),
            vec![0, 0, 0]
        );
        assert_eq!(
            rows.iter().map(|row| row.lane_count).collect::<Vec<_>>(),
            vec![1, 1, 1]
        );
        for row in &rows {
            assert!(row.through_lanes.is_empty());
        }
    }

    #[test]
    fn a_linear_history_draws_straight_edges() {
        let rows = assign_lanes(&[commit("b", &["a"]), commit("a", &[])]);
        assert_eq!(
            rows[0].edges,
            vec![GitGraphEdge {
                from_lane: 0,
                to_lane: 0,
                parent_hash: "a".to_string(),
                kind: GitGraphEdgeKind::Straight,
            }]
        );
        // A root commit has no parent, so it anchors nothing below it.
        assert!(rows[1].edges.is_empty());
    }

    /// A merge's second parent takes a lane of its own, and the edge to it is
    /// a merge edge rather than a straight one.
    #[test]
    fn a_merge_opens_a_second_lane() {
        let rows = assign_lanes(&[
            commit("m", &["a", "b"]),
            commit("a", &["base"]),
            commit("b", &["base"]),
            commit("base", &[]),
        ]);
        assert_eq!(rows[0].lane, 0);
        assert_eq!(rows[0].edges.len(), 2);
        assert_eq!(rows[0].edges[0].kind, GitGraphEdgeKind::Straight);
        assert_eq!(rows[0].edges[0].to_lane, 0);
        assert_eq!(rows[0].edges[1].kind, GitGraphEdgeKind::Merge);
        assert_eq!(rows[0].edges[1].to_lane, 1);
        assert_eq!(rows[0].lane_count, 2);
    }

    /// While a side branch is outstanding, its lane is reported as a
    /// pass-through on rows that do not occupy it.
    #[test]
    fn an_outstanding_branch_shows_as_a_through_lane() {
        let rows = assign_lanes(&[
            commit("m", &["a", "b"]),
            commit("a", &["base"]),
            commit("b", &["base"]),
            commit("base", &[]),
        ]);
        // Row for `a` sits in lane 0 while `b` still waits in lane 1.
        assert_eq!(rows[1].lane, 0);
        assert_eq!(rows[1].through_lanes, vec![1]);
    }

    /// Two children waiting on the same parent converge: the parent appears
    /// once, and the lane the second child had is released.
    #[test]
    fn converging_children_release_their_lanes() {
        let rows = assign_lanes(&[
            commit("m", &["a", "b"]),
            commit("a", &["base"]),
            commit("b", &["base"]),
            commit("base", &[]),
        ]);
        let base = rows.iter().find(|row| row.hash == "base").unwrap();
        // Both a and b reserved `base`; it draws in the leftmost of them.
        assert_eq!(base.lane, 0);
        assert!(
            base.through_lanes.is_empty(),
            "the second lane must be released"
        );
        assert_eq!(
            base.lane_count, 1,
            "trailing empty lanes are compacted away"
        );
    }

    #[test]
    fn a_root_commit_has_no_edges() {
        let rows = assign_lanes(&[commit("only", &[])]);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].edges.is_empty());
        assert_eq!(rows[0].lane, 0);
        assert_eq!(rows[0].lane_count, 1);
    }

    #[test]
    fn an_empty_history_produces_no_rows() {
        assert!(assign_lanes(&[]).is_empty());
    }

    /// An octopus merge (three or more parents) opens a lane per extra parent.
    #[test]
    fn an_octopus_merge_opens_a_lane_per_extra_parent() {
        let rows = assign_lanes(&[
            commit("m", &["a", "b", "c"]),
            commit("a", &[]),
            commit("b", &[]),
            commit("c", &[]),
        ]);
        assert_eq!(rows[0].edges.len(), 3);
        assert_eq!(rows[0].edges[0].to_lane, 0);
        assert_eq!(rows[0].edges[1].to_lane, 1);
        assert_eq!(rows[0].edges[2].to_lane, 2);
        assert_eq!(rows[0].lane_count, 3);
    }

    /// A parent that is not among the listed commits (history truncated by
    /// `--max-count`) still reserves its lane, so the row above it draws a
    /// line heading off the bottom of the rendered graph rather than stopping
    /// short.
    #[test]
    fn a_parent_outside_the_window_still_holds_a_lane() {
        let rows = assign_lanes(&[commit("c", &["missing"])]);
        assert_eq!(rows[0].edges.len(), 1);
        assert_eq!(rows[0].edges[0].parent_hash, "missing");
        assert_eq!(rows[0].edges[0].kind, GitGraphEdgeKind::Straight);
    }

    /// The kind is decided by whether the parent's lane differs, not by parent
    /// count: a merge whose first parent moved lanes is a merge edge.
    #[test]
    fn an_edge_that_changes_lane_is_a_merge_edge() {
        let rows = assign_lanes(&[
            commit("x", &["shared"]),
            commit("y", &["shared"]),
            commit("shared", &[]),
        ]);
        // `x` reserves `shared` in lane 0; `y` lands in lane 1 and its edge
        // must point back left to the lane already holding `shared`.
        assert_eq!(rows[1].lane, 1);
        assert_eq!(rows[1].edges[0].from_lane, 1);
        assert_eq!(rows[1].edges[0].to_lane, 0);
        assert_eq!(rows[1].edges[0].kind, GitGraphEdgeKind::Merge);
    }
}
