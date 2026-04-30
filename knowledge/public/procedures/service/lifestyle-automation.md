# Procedure: Lifestyle & IoT Automation (Rakuten, SwitchBot)

## 1. Goal

Interact with consumer services like Rakuten and IoT controllers like SwitchBot to manage travel bookings, shopping, and home automation.
For scheduling, reservations, purchases, cancellations, and personal-life coordination, follow [lifestyle-booking-playbook.md](knowledge/public/orchestration/lifestyle-booking-playbook.md).

## 2. Dependencies

- **Actuator**: `Service-Actuator` (API/SDK)
- **Actuator**: `Browser-Actuator` (for headful login if required)

## 3. Step-by-Step Instructions

1. **SwitchBot Operation**: Use `Service-Actuator` in `API` mode with `SWITCHBOT_TOKEN`.

   ```json
   {
     "service_id": "switchbot",
     "mode": "API",
     "action": "devices/control",
     "params": { "command": "turnOn" },
     "auth": "secret-guard"
   }
   ```

2. **Rakuten Search**: Use `Service-Actuator` to search for products or travel deals.
3. **Site Selection Preflight**: If a sale, points rate, or campaign may change the best site, compare the user's preferred sites against the live signals before searching.
4. **Order Execution**: If a GUI is required, use `Browser-Actuator` with `navigate-web.md` to complete the transaction securely.
5. **Lifestyle Booking**: Before booking, purchasing, cancelling, or changing a profile, capture the user's constraints, compare candidates, and stop at an approval preview.

## 4. Expected Output

Confirmation of physical device state change or a successfully placed order.
