/** Never send passwordHash (or anything else private) to the client. */
export function publicCustomer(customer) {
  const c = customer.toObject ? customer.toObject() : customer
  return {
    id: c._id.toString(),
    email: c.email,
    name: c.name || '',
    phone: c.phone || '',
    phoneVerified: Boolean(c.phoneVerified),
    role: c.role,
  }
}
