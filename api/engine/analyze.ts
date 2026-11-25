import { engineHandler } from '../../server/engine/function.js'
import { productionAdmission } from '../../server/engine/quota.js'

export default { fetch: engineHandler({ admission: productionAdmission() }) }
