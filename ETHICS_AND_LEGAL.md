# Ethics, Responsible Use, and Legal Disclaimer

## Project Purpose
Guardian and Stratus are part of an ongoing open-source research and prototyping effort dedicated to women's safety, family protection, and personal emergency response in India. In high-risk environments, personal safety tools can assist trusted guardians and emergency contacts with real-time location telemetry, distress signaling, and emergency helpline routing.

This repository is an early-stage work in progress created for academic, educational, and open safety research purposes.

---

## Defensive Engineering Rationale: Protective Disguise and Dual Sensors

A common question in threat modeling is why the mobile client operates disguised as a weather application rather than an obvious safety tool, and why it incorporates dual-camera snapshot capabilities.

### 1. Protective Disguise (Anti-Tampering and De-escalation)
In domestic abuse, street harassment, kidnapping, or physical confrontation, the perpetrator's primary action is almost universally to confiscate the victim's phone.
- Overt Safety Apps: If an aggressor inspects the phone and discovers an app labeled "Safety Beacon", "SOS", or "Emergency Tracker", it triggers immediate escalation, forced uninstallation, or destruction of the phone.
- Protective Disguise: Incorporating the beacon into an authentic, working weather application follows established defensive design principles (similar to protective calculators and fake-call emergency tools). The phone displays legitimate local forecasts and radar, defusing suspicion and ensuring the device remains functional and connected.
- Prevention of Retaliatory Violence: In escalating confrontations, requiring a victim to make overt physical motions to trigger a panic button endangers their physical safety. Background telemetry enables trusted watchers to detect anomalies passively.

### 2. Dual-Camera Verification (Tactical Intelligence)
Remote emergency dispatchers or watchers cannot predict device orientation during an incident.
- Firing both front and back cameras sequentially ensures that visual confirmation is captured regardless of whether the phone is face-up, face-down, or held in hand.
- The dual perspective provides critical situational awareness: the environment (streets, vehicles, landmarks) via the rear camera, and the user perspective (who is holding or operating the phone) via the front camera.
- Using discrete compressed snapshots instead of live video streaming preserves battery life and transmits reliably over weak 2G/3G cellular networks without heating the phone or alerting nearby individuals.

---

## Strict Prohibition of Non-Consensual Monitoring (Anti-Stalkerware Policy)

This software must never be used for non-consensual surveillance, domestic spying, covert stalking, or unauthorized tracking of any individual. 

- Consensual deployment only: Guardian must only be installed on devices you own or devices whose user has granted explicit, informed, and ongoing consent.
- Non-consensual tracking is illegal: Secretly tracking another person without their informed consent violates criminal and privacy laws across jurisdictions, including:
  - Section 354D of the Indian Penal Code (IPC) / Bharatiya Nyaya Sanhita (BNS) (Criminal Stalking).
  - Section 43 and Section 66E of the Information Technology Act, 2000 (Unauthorized computer access and violation of bodily privacy).
  - The Digital Personal Data Protection Act (DPDPA), 2023.
  - Corresponding international privacy statutes and wiretapping legislation worldwide.

The authors and contributors of this repository strictly condemn the use of this software as stalkerware or spyware.

---

## Disclaimer of Liability

1. Educational and Research Prototype:
This software is provided on an "as is" and "as available" basis without warranties of any kind, whether express or implied. It is an experimental work in progress and should not be relied upon as a replacement for certified emergency dispatch or institutional law enforcement services.

2. Zero Author Liability:
In no event shall the authors, maintainers, or contributors be held liable for any claim, damages, criminal misuse, civil penalties, or legal liabilities arising from the download, execution, deployment, or modification of this codebase by third parties.

3. User Compliance:
Any person deploying, building, or modifying this code assumes sole and absolute responsibility for complying with all applicable local, state, national, and international laws regarding surveillance, data protection, and privacy.
