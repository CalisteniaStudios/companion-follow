# Companion Follow

Companion Follow is a system-agnostic Foundry VTT module for making pets, familiars, companions, escorts, and other tokens follow a leader without configuring mounts or vehicles.

It supports Foundry VTT v13 and v14.

This first release is a beta intended for live-table testing before public distribution.

## Quick start

1. Select one or more tokens that should become followers.
2. Hover the pointer over the leader token, or target it.
3. Press **F**.
4. Select a follower and press **Shift + F** to stop following.

You can also use the dog and broken-link buttons in the Token scene controls. In the Token HUD, target or hover a leader and click the dog button on the token that should follow it.

Follow relationships are saved on the tokens and remain active after reloading the world.

## Cross-Scene copy

The **Copy followers with the leader** setting is enabled by default.

1. Copy the leader token normally.
2. Open another Scene.
3. Paste the leader.

The module adds all of that leader's followers to the paste, preserves their relative formation, and reconnects them to the newly created leader. Nested follower chains are copied as well. The original tokens remain in the original Scene because this is a copy operation.

Copying a follower without its leader intentionally removes the copied token's old follow relationship, preventing it from trying to follow a token in another Scene.

## Options

- Trail behind the leader or preserve formation.
- Copy followers with the leader.
- Snap movement to the grid.
- Respect movement-blocking walls.
- Rotate followers toward their movement direction.
- Stop following when a follower is moved manually.
- Pause, detach, or continue during combat.
- Optionally detach on long teleports.

## Notes

- Cross-Scene transfer is attached to Foundry's normal copy and paste workflow.
- Movement-wall checks apply when the follower is on the currently viewed Scene.
- The active GM coordinates automatic movement. If no GM is connected, the user who moved the leader coordinates followers they can manage.

## License

MIT. See [LICENSE](LICENSE).
