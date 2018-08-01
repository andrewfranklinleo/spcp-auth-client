const xmlCrypto = require("xml-crypto")
const xpath = require("xpath")
const DOMParser = require("xmldom").DOMParser
const xmlEnc = require("xml-encryption")
const request = require("request")

/**
 * Helper class to assist authenication process with spcp servers
 */
class NDIAuthClient {

  /**
   * Creates an instance of the class
   * @param  {Object} config - Configuration parameters for instance
   */
  constructor(config) {

    const PARAMS = [
      "partnerEntityId",
      "idpEndpoint",
      "idpLoginURL",
      "appKey",
      "appCert",
      "spcpCert",
      "esrvcID"
    ]

    for (let param of PARAMS) {
      if (config[param]) {
        this[param] = config[param]
      } else {
        throw param + " undefined"
      }
    }

  }

  /**
   * Generates redirect URL to Official SPCP log-in page
   * @param  {String} target - State to pass SPCP
   * @return {String} redirectURL - SPCP page to redirect to
   */
  createRedirectURL(target) {
    if (!target) {
      return new Error('Target undefined')
    }
    return this.idpLoginURL + 
      "?RequestBinding=HTTPArtifact" + 
      "&ResponseBinding=HTTPArtifact" +
      "&PartnerId=" + encodeURI(this.partnerEntityId) +
      "&Target=" + encodeURI(target) +
      "&NameIdFormat=Email" +
      "&esrvcID=" + this.esrvcID
  }

  /**
   * Signs xml with provided key
   * @param  {String} xml - Xml containing artifact to be signed
   * @return {String} artifactResolve - Artifact resolve to send to SPCP
   */
  signXML(xml) {
    let sig = new xmlCrypto.SignedXml()

    let transforms = [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ]
    let digestAlgorithm = "http://www.w3.org/2001/04/xmlenc#sha256"
    let xpath = "//*[local-name(.)='ArtifactResolve']"
    sig.addReference(xpath, transforms, digestAlgorithm)

    sig.signingKey = this.appKey
    sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"

    let artifactResolve = null
    let signingError = null

    try {
      sig.computeSignature(xml, { prefix: "ds" })
      artifactResolve =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
        "<soapenv:Header />" +
        "<soapenv:Body>" +
        sig.getSignedXml() +
        "</soapenv:Body>" +
        "</soapenv:Envelope>"
    } catch (err) {
      signingError = err
    }

    return { artifactResolve, signingError }
  
  }

  /**
   * Verifies signatures in artifact response from SPCP based on public key of SPCP
   * @param  {String} xml - Artifact Response from SPCP
   * @param  {Array} signatures - Array of signatures extracted from artifact response
   * @return {Boolean} sig0 - Boolean value of whether signatures in artifact response are verified
   */
  verifyXML(xml, signatures) {
    /**
     * Creates KeyInfo function
     * @param  {String} key - Public key of SPCP
     */
    function KeyInfo(key) {
      this.getKey = function() {
        return key
      }
    }

    let verifier
    let sig0
    let sig1
    verifier = new xmlCrypto.SignedXml()
    verifier.keyInfoProvider = new KeyInfo(this.spcpCert)

    let isVerified = null
    let verificationError = null

    // Artifact Response should contain 2 signatures
    if (!signatures || signatures.length != 2) {
      verificationError = "Artifact Response must contain 2 signatures"
      return { isVerified, verificationError }
    }

    // Check Signature 0
    verifier.loadSignature(signatures[0].toString())
    sig0 = verifier.checkSignature(xml)
    if (!sig0) {
      verificationError = verifier.validationErrors
      return { isVerified, verificationError }
    }

    // Check Signature 1
    verifier.loadSignature(signatures[1].toString())
    sig1 = verifier.checkSignature(xml)
    if (!sig1) {
      verificationError = verifier.validationErrors
      return { isVerified, verificationError }
    }

    isVerified = sig0 & sig1
    return { isVerified, verificationError }
  }

  /**
   * Decrypts encrypted data in artifact response from SPCP based on app private key
   * @param  {String} encryptedData - Encrypted data in artifact response from SPCP
   * @return {String} nric - Decrypted NRIC from encrypted data
   */
  decryptXML(encryptedData) {
    let decryptedData
    let nric = null
    let decryptionError = null
    let options = {
      key: this.appKey,
    }

    // TODO: do not mutate input variables; have separate variables for each decrypted thing
    xmlEnc.decrypt(encryptedData.toString(), options, function(err, result) {
      if (err) {
        decryptionError = err
        return { nric, decryptionError }
      } else {
        decryptedData = new DOMParser().parseFromString(result)
        encryptedData = xpath.select(
          "//*[local-name(.)='EncryptedData']",
          decryptedData
        )
      }
      xmlEnc.decrypt(encryptedData.toString(), options, function(err, result) {
        if (err) {
          decryptionError = err
          return { nric, decryptionError }
        } else {
          decryptedData = new DOMParser().parseFromString(result)
          if (decryptedData) {
            if (decryptedData.documentElement) {
              if (decryptedData.documentElement.childNodes["0"]) {
                nric = decryptedData.documentElement.childNodes["0"].data
              }
            }
          }
        }
      })
    })
    return { nric, decryptionError }
  }

  /**
   * Carries artifactResolve and artifactResponse protocol
   * @param  {String} samlArt - Token returned by spcp server via browser redirect
   * @param  {String} relayState - State passed in on intial spcp redirect
   * @param {Function} callback - Callback function with inputs error and NRIC
   */
  getNRIC(samlArt, relayState, callback) {
    // Step 1: Check if relay state present
    if (!samlArt || !relayState ) {
      callback(new Error("Error in Step 1: Callback or saml artifact not present"), { relayState })
    } else {
      // Step 2: Form Artifact Resolve with Artifact and Sign
      const xml =
        '<samlp:ArtifactResolve xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"' +
        'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"' +
        ' Destination="' +
        this.idpEndpoint +
        '" ID="_0" Version="2.0">' +
        '<saml:Issuer Format="urn:oasis:names:tc:SAML:2.0:nameid-format:entity">' +
        this.partnerEntityId +
        "</saml:Issuer>" +
        "<samlp:Artifact>" +
        samlArt +
        "</samlp:Artifact>" +
        "</samlp:ArtifactResolve>"
      const { artifactResolve, signingError } = this.signXML(xml)

      if (!artifactResolve) {
        const nestedError = new Error("Error in Step 2: Form Artifact Resolve with Artifact and Sign")
        nestedError.cause = signingError
        callback(nestedError, { relayState })
      } else {
        // Step 3: Send Artifact Resolve over OOB
        request.post(
          {
            headers: {
              "content-type": "text/xml; charset=utf-8",
              "SOAPAction": "http://www.oasis-open.org/committees/security",
            },
            url: this.idpEndpoint,
            body: artifactResolve,
          }, (resolveError, response, body) => {
            if (resolveError) {
              const nestedError = new Error("Error in Step 3: Send Artifact Resolve over OOB")
              nestedError.cause = resolveError
              callback(nestedError, { relayState })
            } else {
              // Step 4: Verify Artifact Response
              let responseXML = body
              let responseDOM = new DOMParser().parseFromString(responseXML)
              let signatures = xpath.select(
                "//*[local-name(.)='Signature']",
                responseDOM
              )
              const { isVerified, verificationError } = this.verifyXML(responseXML, signatures)
              if (!isVerified) {
                const nestedError = new Error("Error in Step 4: Verify Artifact Response")
                nestedError.cause = verificationError
                callback(nestedError, { relayState })
              } else {
                // Step 5: Decrypt Artifact Response
                let encryptedData = xpath.select(
                  "//*[local-name(.)='EncryptedData']",
                  responseDOM
                )
                const { nric, decryptionError } = this.decryptXML(encryptedData)
                let isValidNRIC = /^([STFGstfg]{1})+([0-9]{7})+([A-Za-z]{1})$/
                if (nric && isValidNRIC.test(nric)) {
                  callback(null, { nric, relayState })
                } else {
                  const nestedError = new Error("Error in Step 5: Decrypt Artifact Response")
                  nestedError.cause = decryptionError
                  callback(nestedError, { relayState })
                }
              }
            }
          }
        )
      }
    }
  }
}

module.exports = NDIAuthClient