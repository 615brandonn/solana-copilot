# Fresh-tail v1 launch retention

Fresh-tail v1 monitors each newly enrolled mint for a fixed one-hour launch
campaign, measured from its latest finalized supply event. The short,
operator-adjustable accumulation window still controls entry evidence; it does
not shorten the monitoring lifetime.

After one finalized hour without a supply event, a mint may retire only when it
has no live coverage request, unresolved entry claim, open position, or
unresolved exit intent. The database repeats those checks while holding the
mint advisory lock. Retirement is permanent and releases the mint's descendant
work from the observer snapshot.

A target returning to the mint after retirement is intentionally not a
fresh-tail v1 opportunity. Detecting later revivals requires a separate bounded
reactivation contract; v1 must not silently present itself as eventual-conviction
coverage.
