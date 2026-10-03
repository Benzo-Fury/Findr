/**
 * What the updater knows: the running version, the latest release, and
 * whether it can be installed. Open to every signed-in user, so anyone can be
 * told an update is waiting; only admins can act on it.
 */

import Updater from "../../lib/updates/Updater"
import { factory } from "../../lib/routing/factory"

export default factory({
  GET: (c) => c.json(Updater.getInstance().status),
})
