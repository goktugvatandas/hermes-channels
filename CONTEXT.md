# Hermes Channels Domain Glossary

## Card

A unit of tracked work on a channel's board.

## Card Reference

A stable, human-facing name for a Card, formed from its board prefix and a monotonically increasing number, such as `SD-1` or `CR-12`. Every board receives a generated prefix automatically; the user may override it in Channels Settings. Card References are never reused and are the canonical way humans and bots refer to work in conversation.

## Task ID

The opaque identity Hermes uses internally for a Card, such as `t_4921604a`. Task IDs remain stable for machine operations but are not part of the human-facing language.

## Board Prefix

The short code used by every Card Reference on a board. Channels generates one automatically from the board slug; the user may override or reset it from Settings → Card prefixes.
