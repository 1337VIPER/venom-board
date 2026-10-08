using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace VenomBoard.Editor
{
    /// <summary>
    /// A small JSON reader and writer, so the package needs no other packages. Objects become
    /// Dictionary&lt;string, object&gt;, arrays List&lt;object&gt;, whole numbers long, other numbers double.
    /// </summary>
    public static class MiniJson
    {
        const int MaxDepth = 64;

        public static object Parse(string json)
        {
            if (json == null) throw new FormatException("No JSON to read.");
            var reader = new Reader(json);
            reader.SkipWhitespace();
            var value = reader.ReadValue(0);
            reader.SkipWhitespace();
            if (!reader.AtEnd) throw new FormatException("Unexpected text after the JSON value.");
            return value;
        }

        public static bool TryParse(string json, out object value)
        {
            try
            {
                value = Parse(json);
                return true;
            }
            catch (FormatException)
            {
                value = null;
                return false;
            }
        }

        public static string Serialize(object value)
        {
            var sb = new StringBuilder();
            Write(sb, value, 0);
            return sb.ToString();
        }

        sealed class Reader
        {
            readonly string text;
            int pos;

            public Reader(string text) { this.text = text; }

            public bool AtEnd => pos >= text.Length;

            public void SkipWhitespace()
            {
                while (pos < text.Length && (text[pos] == ' ' || text[pos] == '\t' || text[pos] == '\n' || text[pos] == '\r')) pos++;
            }

            public object ReadValue(int depth)
            {
                if (depth > MaxDepth) throw new FormatException("The JSON is nested too deeply.");
                if (AtEnd) throw new FormatException("The JSON ended early.");
                char c = text[pos];
                switch (c)
                {
                    case '{': return ReadObject(depth);
                    case '[': return ReadArray(depth);
                    case '"': return ReadString();
                    case 't': Expect("true"); return true;
                    case 'f': Expect("false"); return false;
                    case 'n': Expect("null"); return null;
                    default:
                        if (c == '-' || (c >= '0' && c <= '9')) return ReadNumber();
                        throw new FormatException("Unexpected character '" + c + "' at " + pos + ".");
                }
            }

            void Expect(string word)
            {
                if (string.CompareOrdinal(text, pos, word, 0, word.Length) != 0) throw new FormatException("Expected " + word + " at " + pos + ".");
                pos += word.Length;
            }

            Dictionary<string, object> ReadObject(int depth)
            {
                var result = new Dictionary<string, object>(StringComparer.Ordinal);
                pos++;  // {
                SkipWhitespace();
                if (!AtEnd && text[pos] == '}') { pos++; return result; }
                while (true)
                {
                    SkipWhitespace();
                    if (AtEnd || text[pos] != '"') throw new FormatException("Expected a property name at " + pos + ".");
                    string key = ReadString();
                    SkipWhitespace();
                    if (AtEnd || text[pos] != ':') throw new FormatException("Expected ':' at " + pos + ".");
                    pos++;
                    SkipWhitespace();
                    result[key] = ReadValue(depth + 1);
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("The JSON ended inside an object.");
                    if (text[pos] == ',') { pos++; continue; }
                    if (text[pos] == '}') { pos++; return result; }
                    throw new FormatException("Expected ',' or '}' at " + pos + ".");
                }
            }

            List<object> ReadArray(int depth)
            {
                var result = new List<object>();
                pos++;  // [
                SkipWhitespace();
                if (!AtEnd && text[pos] == ']') { pos++; return result; }
                while (true)
                {
                    SkipWhitespace();
                    result.Add(ReadValue(depth + 1));
                    SkipWhitespace();
                    if (AtEnd) throw new FormatException("The JSON ended inside an array.");
                    if (text[pos] == ',') { pos++; continue; }
                    if (text[pos] == ']') { pos++; return result; }
                    throw new FormatException("Expected ',' or ']' at " + pos + ".");
                }
            }

            string ReadString()
            {
                pos++;  // opening quote
                var sb = new StringBuilder();
                while (true)
                {
                    if (AtEnd) throw new FormatException("The JSON ended inside a string.");
                    char c = text[pos++];
                    if (c == '"') return sb.ToString();
                    if (c < ' ') throw new FormatException("Control character inside a string.");
                    if (c != '\\') { sb.Append(c); continue; }
                    if (AtEnd) throw new FormatException("The JSON ended inside a string.");
                    char e = text[pos++];
                    switch (e)
                    {
                        case '"': sb.Append('"'); break;
                        case '\\': sb.Append('\\'); break;
                        case '/': sb.Append('/'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'n': sb.Append('\n'); break;
                        case 'r': sb.Append('\r'); break;
                        case 't': sb.Append('\t'); break;
                        case 'u':
                            if (pos + 4 > text.Length) throw new FormatException("Bad \\u escape.");
                            int code;
                            if (!int.TryParse(text.Substring(pos, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new FormatException("Bad \\u escape.");
                            sb.Append((char)code);
                            pos += 4;
                            break;
                        default: throw new FormatException("Bad escape \\" + e + ".");
                    }
                }
            }

            object ReadNumber()
            {
                int start = pos;
                bool whole = true;
                if (text[pos] == '-') pos++;
                while (!AtEnd)
                {
                    char c = text[pos];
                    if (c >= '0' && c <= '9') { pos++; continue; }
                    if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') { whole = false; pos++; continue; }
                    break;
                }
                string s = text.Substring(start, pos - start);
                long l;
                if (whole && long.TryParse(s, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out l)) return l;
                double d;
                if (double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out d)) return d;
                throw new FormatException("Bad number '" + s + "'.");
            }
        }

        static void Write(StringBuilder sb, object value, int depth)
        {
            if (depth > MaxDepth) throw new InvalidOperationException("The value is nested too deeply to write as JSON.");
            if (value == null) { sb.Append("null"); return; }
            var s = value as string;
            if (s != null) { WriteString(sb, s); return; }
            if (value is bool) { sb.Append((bool)value ? "true" : "false"); return; }
            if (value is int || value is long || value is short || value is byte || value is uint || value is ulong)
            {
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                return;
            }
            if (value is float || value is double || value is decimal)
            {
                double d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                sb.Append(double.IsNaN(d) || double.IsInfinity(d) ? "null" : d.ToString("R", CultureInfo.InvariantCulture));
                return;
            }
            var dict = value as IDictionary;
            if (dict != null)
            {
                sb.Append('{');
                bool first = true;
                foreach (DictionaryEntry entry in dict)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    WriteString(sb, Convert.ToString(entry.Key, CultureInfo.InvariantCulture));
                    sb.Append(':');
                    Write(sb, entry.Value, depth + 1);
                }
                sb.Append('}');
                return;
            }
            var list = value as IEnumerable;
            if (list != null)
            {
                sb.Append('[');
                bool first = true;
                foreach (var item in list)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    Write(sb, item, depth + 1);
                }
                sb.Append(']');
                return;
            }
            WriteString(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    default:
                        if (c < ' ' || c == (char)0x2028 || c == (char)0x2029) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
